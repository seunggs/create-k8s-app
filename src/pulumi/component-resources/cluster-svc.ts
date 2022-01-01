import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'
import * as certmanager from '@pulumi/kubernetes-cert-manager'
// import * as emissary from '../k8s-crds/emissary'
import {
  getRoute53AddRecordsPolicy,
  getRoleTrustPolicy,
} from '../iam-policies'

interface KarpenterArgs {
  awsAccountId: string,
  awsRegion: string,
  clusterName: string,
  clusterEndpoint: string,
  nodeGroupRole: aws.iam.Role,
  eksHash: pulumi.Output<string>,
}

export class Karpenter extends pulumi.ComponentResource {
  constructor(name: string, args: KarpenterArgs, opts: any) {
    super('custom:k8s:Karpenter', name, {}, opts)

    const {
      awsAccountId,
      awsRegion,
      clusterName,
      clusterEndpoint,
      nodeGroupRole,
      eksHash,
    } = args

    const karpenterNamespaceName = 'karpenter'
    const karpenterReleaseName = 'karpenter-release'
    const karpenterServiceAccountName = 'karpenter'

    // Tag Subnets
    //    > Done in cluster setup

    // Create the KarpenterNode IAM Role
    //    > Reuse the managed node group role from cluster setup

    // Create an InstanceProfile Karpenter can use to assign a role to EC2 instances it manages
    const karpenterNodeInstanceProfileName = `KarpenterNodeInstanceProfile-${clusterName}`
    const karpenterNodeInstanceProfile = new aws.iam.InstanceProfile(karpenterNodeInstanceProfileName, {
      name: karpenterNodeInstanceProfileName,
      role: nodeGroupRole.name,
    });

    // Create the KarpenterController IAM Role
    const karpenterControllerRoleName = `KarpenterControllerRole-${clusterName}`
    const karpenterControllerRole = new aws.iam.Role(karpenterControllerRoleName, {
      name: karpenterControllerRoleName,
      path: '/',
      description: 'Karpenter controller role',
      assumeRolePolicy: getRoleTrustPolicy({
        awsRegion,
        awsAccountId,
        eksHash,
        namespace: karpenterNamespaceName,
        serviceAccountName: karpenterServiceAccountName,
      }),
    })

    const karpenterControllerPolicyName = `KarpenterControllerPolicy-${clusterName}`
    const karpenterControllerPolicy = new aws.iam.Policy(karpenterControllerPolicyName, {
      name: karpenterControllerPolicyName,
      path: '/',
      description: 'Karpenter Controller Policy',
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Resource: '*',
          Action: [
            'ec2:CreateLaunchTemplate',
            'ec2:CreateFleet',
            'ec2:RunInstances',
            'ec2:CreateTags',
            'iam:PassRole',
            'ec2:TerminateInstances',
            'ec2:DescribeLaunchTemplates',
            'ec2:DescribeInstances',
            'ec2:DescribeSecurityGroups',
            'ec2:DescribeSubnets',
            'ec2:DescribeInstanceTypes',
            'ec2:DescribeInstanceTypeOfferings',
            'ec2:DescribeAvailabilityZones',
            'ssm:GetParameter',
          ],
        }],
      }),
    })
    new aws.iam.RolePolicyAttachment(`${karpenterControllerPolicyName}-attachment`, {
      role: karpenterControllerRole.name,
      policyArn: karpenterControllerPolicy.arn,
    })

    // // Create the EC2 Spot Service Linked Role

    // Set up Karpenter via Helm
    const karpenter = new k8s.helm.v3.Release(karpenterReleaseName, {
      name: karpenterReleaseName,
      namespace: karpenterNamespaceName,
      createNamespace: true,
      chart: 'karpenter',
      version: '0.5.3',
      repositoryOpts: {
        repo: 'https://charts.karpenter.sh',
      },
      values: {
        serviceAccount: {
          annotations: {
            'eks.amazonaws.com/role-arn': karpenterControllerRole.arn,
          },
        },
        controller: {
          clusterName,
          clusterEndpoint,
        },
      },
      cleanupOnFail: true,
    }, { parent: this })

    // Set up Karpenter Provisioner
    const karpenterProvisioner = new k8s.apiextensions.CustomResource('karpenter-provisioner', {
      apiVersion: 'karpenter.sh/v1alpha5',
      kind: 'Provisioner',
      metadata: {
        name: 'default'
      },
      spec: {
        limits: {
          resources: {
            cpu: 1000
          },
        },
        provider: {
          instanceProfile: `KarpenterNodeInstanceProfile-${clusterName}`,
          subnetSelector: {
            [`kubernetes.io/cluster/${clusterName}`]: '*',
          },
          securityGroupSelector: {
            [`kubernetes.io/cluster/${clusterName}`]: '*',
          }
        },
        ttlSecondsAfterEmpty: 30,
      }
    }, { parent: this, dependsOn: [karpenter] })

    this.registerOutputs()
  }
}

interface CertManagerArgs {
  project: string,
  awsAccountId: string,
  awsRegion: string,
  certManagerNamespaceName: string,
  // hostedZoneId: string,
  eksHash: pulumi.Output<string>,
}

export class CertManager extends pulumi.ComponentResource {
  constructor(name: string, args: CertManagerArgs, opts: any) {
    super('custom:k8s:CertManager', name, {}, opts)

    const {
      project,
      awsAccountId,
      awsRegion,
      certManagerNamespaceName,
      // hostedZoneId,
      eksHash,
    } = args

    const certManagerName = 'cert-manager'
    const certManagerNamespace = new k8s.core.v1.Namespace(certManagerNamespaceName, {
      metadata: { name: certManagerNamespaceName },
    }, { parent: this })

    const certManagerRoleName = `CertManager-${project}`
    const certManagerServiceAccountName = 'cert-manager'

    /**
     * Set up IAM role for cert-manager ServiceAccount
     */
    const certManagerRole = new aws.iam.Role('cert-manager', {
      name: certManagerRoleName,
      path: '/',
      description: 'cert-manager role',
      assumeRolePolicy: getRoleTrustPolicy({
        awsRegion,
        awsAccountId,
        eksHash,
        namespace: certManagerNamespaceName,
        serviceAccountName: certManagerServiceAccountName,
      }),
    })
    // certManagerRole.arn.apply(cmRoleArn => console.log('certManagerRole.arn', cmRoleArn))

    // Attach permissions to allow adding records to Route 53 for DNS01 challenge
    const route53AddRecordsPolicyName = 'route-53-add-records-policy'
    const route53AddRecordsPolicy = new aws.iam.Policy(route53AddRecordsPolicyName, {
      namePrefix: route53AddRecordsPolicyName,
      description: 'allow adding records to Route 53',
      policy: getRoute53AddRecordsPolicy(),
    })
    new aws.iam.RolePolicyAttachment(`${route53AddRecordsPolicyName}-attachment`, {
      role: certManagerRole.name,
      policyArn: route53AddRecordsPolicy.arn,
    })

    /**
     * Install cert-manager
     */
    // TODO: replace certManagerRoleArn with Pulumi output when the Pulumi bug is fixed
    const certManagerRoleArn = pulumi.interpolate`arn:aws:iam::${awsAccountId}:role/${certManagerRoleName}`
    // const certManagerRoleArn = certManagerRole.arn
    const certManager = new certmanager.CertManager(certManagerName, {
      installCRDs: true,
      helmOptions: {
        version: '1.5.4',
        name: certManagerName,
        namespace: certManagerNamespaceName, // must be a string due to the above Pulumi bug
      },
      serviceAccount: {
        annotations: {
          'eks.amazonaws.com/role-arn': certManagerRoleArn, // make sure this role arn is correct
        }
      },
      securityContext: {
        fsGroup: 1001,
      },
    }, { parent: this, dependsOn: [certManagerNamespace, certManagerRole] })
    // certManagerRoleArn.apply(t => console.log('certManagerRoleArn', t))

    this.registerOutputs()
  }
}

interface CertManagerCertificateArgs {
  namespace?: string,
  dnsName: string, // i.e. hostname or `*.${hostname}` for wildcard
  tlsSecretName: string,
}

export class CertManagerCertificate extends pulumi.ComponentResource {
  secretName: string

  constructor(name: string, args: CertManagerCertificateArgs, opts: any) {
    super('custom:k8s:CertManagerCertificate', name, {}, opts)

    const {
      namespace = 'default',
      dnsName,
      tlsSecretName,
    } = args

    const cert = new k8s.apiextensions.CustomResource(name, {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name,
        namespace,
      },
      spec: {
        secretName: tlsSecretName,
        duration: '2160h', // 90d
        renewBefore: '360h', // 15d
        issuerRef: {
          kind: 'ClusterIssuer',
          name: 'letsencrypt-dns-issuer',
        },
        commonName: dnsName,
        dnsNames: [dnsName],
      }
    }, { parent: this })

    this.secretName = tlsSecretName

    this.registerOutputs()
  }
}

/**
 * Install Emissary using the Helm chart
 */
interface EmissaryArgs {
  emissaryNamespaceName: string,
}

export class Emissary extends pulumi.ComponentResource {
  constructor(name: string, args: EmissaryArgs, opts: any) {
    super('custom:k8s:Emissary', name, {}, opts)

    const { emissaryNamespaceName } = args

    const emissaryNamespace = new k8s.core.v1.Namespace(emissaryNamespaceName, {
      metadata: { name: emissaryNamespaceName }
    }, { parent: this })

    // Install CRDs
    const emissaryCrds = new k8s.yaml.ConfigGroup('emissary-crds', {
      files: 'https://app.getambassador.io/yaml/emissary/2.1.0/emissary-crds.yaml',
    }, { parent: this })

    // Install Emissary Ingress via Helm
    const emissaryReleaseName = 'emissary-ingress'
    const emissaryRelease = new k8s.helm.v3.Release(emissaryReleaseName, {
      name: emissaryReleaseName,
      namespace: emissaryNamespace.metadata.name,
      chart: 'emissary-ingress',
      repositoryOpts: {
        repo: 'https://app.getambassador.io',
      },
      cleanupOnFail: true,
    }, { parent: this, dependsOn: [emissaryCrds] })

    this.registerOutputs()
  }
}

interface EmissaryListenerArgs {
  namespace: string,
  labels?: { [key: string]: string },
}

export class EmissaryListener extends pulumi.ComponentResource {
  constructor(name: string, args: EmissaryListenerArgs, opts: any) {
    super('custom:k8s:EmissaryListener', name, {}, opts)

    const {
      namespace,
      labels,
    } = args

    // Set up http listener
    const httpListenerName = `http-listener`
    const httpListener = new k8s.apiextensions.CustomResource(httpListenerName, {
      apiVersion: 'getambassador.io/v3alpha1',
      kind: 'Listener',
      metadata: {
        name: httpListenerName,
        namespace,
      },
      spec: {
        port: 8080, // See the Load Balancer service in emissary ns - maps port 80 to 8080
        protocol: 'HTTPS',
        securityModel: 'XFP',
        hostBinding: labels ? {
          selector: {
            matchLabels: labels,
          },
        } : {
          namespace: {
            from: 'SELF',
          }
        }
      }
    }, { parent: this })

    // Set up https listener
    const httpsListenerName = `https-listener`
    const httpsListener = new k8s.apiextensions.CustomResource(httpsListenerName, {
      apiVersion: 'getambassador.io/v3alpha1',
      kind: 'Listener',
      metadata: {
        name: httpsListenerName,
        namespace,
      },
      spec: {
        port: 8443,
        protocol: 'HTTPS',
        securityModel: 'XFP',
        hostBinding: labels ? {
          selector: {
            matchLabels: labels,
          },
        } : {
          namespace: {
            from: 'SELF',
          }
        }
      }
    }, { parent: this })

    this.registerOutputs()
  }
}

interface EmissaryHostArgs {
  namePrefix: string,
  namespace: string,
  labels?: { [key: string]: string },
  hostname: string,
  tlsSecretName: string,
}

export class EmissaryHost extends pulumi.ComponentResource {
  constructor(name: string, args: EmissaryHostArgs, opts: any) {
    super('custom:k8s:EmissaryHost', name, {}, opts)

    const {
      namePrefix,
      namespace,
      labels,
      hostname,
      tlsSecretName,
    } = args

    const emissaryHostName = `${namePrefix}-host`
    const emissaryHost = new k8s.apiextensions.CustomResource(emissaryHostName, {
      apiVersion: 'getambassador.io/v3alpha1',
      kind: 'Host',
      metadata: {
        name: emissaryHostName,
        namespace,
        ...labels ? { labels } : {},
      },
      spec: {
        hostname,
        tlsSecret: {
          name: tlsSecretName,
        },
        ...labels ? {
          mappingSelector: {
            matchLabels: labels,
          }
        } : {},
        requestPolicy: {
          insecure: {
            action: 'Redirect',
          },
        },
      },
    }, { parent: this })

    this.registerOutputs()
  }
}

interface EmissaryMappingArgs {
  labels?: { [key: string]: string },
  namespace?: string,
  hostname?: string,
  prefix?: string,
  rewrite?: string,
  qualifiedSvcName: string, // <service-name>.<namespace>
}

export class EmissaryMapping extends pulumi.ComponentResource {
  constructor(name: string, args: EmissaryMappingArgs, opts: any) {
    super('custom:k8s:EmissaryMapping', name, {}, opts)

    const {
      namespace = 'default',
      labels,
      hostname,
      prefix = '/',
      rewrite,
      qualifiedSvcName,
    } = args

    const svcMappingName = name
    const svcMapping = new k8s.apiextensions.CustomResource(svcMappingName, {
      apiVersion: 'getambassador.io/v3alpha1',
      kind: 'Mapping',
      metadata: {
        name: svcMappingName,
        namespace,
        ...labels ? { labels } : {},
      },
      spec: {
        ...hostname ? { hostname } : {},
        prefix,
        ...rewrite ? { rewrite } : {},
        service: qualifiedSvcName,
      },
    }, { parent: this })

    this.registerOutputs()
  }
}

/**
 * Install Istio using the Helm chart
 */
export class Istio extends pulumi.ComponentResource {
  id: pulumi.Output<String>
  name: pulumi.Output<String>

  constructor(name: string, args: any, opts: any) {
    super('custom:k8s:Istio', name, {}, opts)

    const istioSystemNamespaceName = 'istio-system'
    const istioSystemNamespace = new k8s.core.v1.Namespace(istioSystemNamespaceName, {
      metadata: { name: istioSystemNamespaceName }
    }, { parent: this })

    const istioBaseReleaseName = 'istio-base'
    const istioBaseRelease = new k8s.helm.v3.Release(istioBaseReleaseName, {
      name: istioBaseReleaseName,
      namespace: istioSystemNamespace.metadata.name,
      chart: 'base',
      repositoryOpts: {
        repo: 'https://istio-release.storage.googleapis.com/charts',
      },
      cleanupOnFail: true,
    }, { parent: this })

    const istioIstiodReleaseName = 'istiod'
    const istioIstiodRelease = new k8s.helm.v3.Release(istioIstiodReleaseName, {
      name: istioIstiodReleaseName,
      namespace: istioSystemNamespace.metadata.name,
      chart: 'istiod',
      repositoryOpts: {
        repo: 'https://istio-release.storage.googleapis.com/charts',
      },
      cleanupOnFail: true,
    }, { parent: this, dependsOn: [istioBaseRelease] })

    const istio = new k8s.apiextensions.CustomResource(name, {
      apiVersion: 'install.istio.io/v1alpha1',
      kind: 'IstioOperator',
      metadata: {
        namespace: istioSystemNamespace.metadata.name,
        name: `${name}-controlplane`
      },
      spec: {
        values: {
          global: {
            proxy: {
              autoInject: 'enabled'
            },
            useMCP: false,
            jwtPolicy: 'first-party-jwt'
          }
        },
        addonComponents: {
          pilot: {
            enabled: true
          }
        },
        components: {
          ingressGateways: [
            {
              name: 'istio-ingressgateway',
              enabled: true
            }
          ]
        }
      }
    }, { parent: this, dependsOn: [istioIstiodRelease] })

    this.id = istio.id
    this.name = istio.metadata.name

    this.registerOutputs()
  }
}

/**
 * Dapr
 */
export class Dapr extends pulumi.ComponentResource {
  constructor(name: string, args: any, opts: any) {
    super('custom:k8s:Dapr', name, {}, opts)

    const daprSystemNamespaceName = 'dapr-system'
    const daprSystemNamespace = new k8s.core.v1.Namespace(daprSystemNamespaceName, {
      metadata: { name: daprSystemNamespaceName }
    }, { parent: this })

    // Install Dapr via Helm
    const daprReleaseName = 'dapr'
    const daprRelease = new k8s.helm.v3.Release(daprReleaseName, {
      name: daprReleaseName,
      namespace: daprSystemNamespace.metadata.name,
      chart: 'dapr',
      repositoryOpts: {
        repo: 'https://dapr.github.io/helm-charts/',
      },
      version: '1.5',
      values: {
        global: {
          ha: {
            enabled: true,
          },
        },
      },
      cleanupOnFail: true,
    }, { parent: this })

    this.registerOutputs()
  }
}

export class Vault extends pulumi.ComponentResource {
  constructor(name: string, args: any, opts: any) {
    super('custom:k8s:Vault', name, {}, opts)

    // Install Hashicorp Vault via Helm
    const vaultNamespaceName = 'vault'
    const vaultReleaseName = 'vault'
    const vault = new k8s.helm.v3.Release(vaultReleaseName, {
      name: vaultReleaseName,
      namespace: vaultNamespaceName,
      createNamespace: true,
      chart: 'vault',
      repositoryOpts: {
        repo: 'https://helm.releases.hashicorp.com',
      },
      cleanupOnFail: true,
    }, { parent: this })

    this.registerOutputs()
  }
}
