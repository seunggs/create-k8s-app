import * as path from 'path'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'
import * as certmanager from '@pulumi/kubernetes-cert-manager'

import {
  getClusterAutoscalerPolicy,
  getRoute53AddRecordsPolicy,
  getCertManagerRoleTrustPolicy,
  getClusterAutoscalerRoleTrustPolicy,
} from './iam-policies'

/**
 * Set up ClusterAutoscaler
 * 
 *    To verify: `kubectl logs <cluster-autoscaler deployment> -n kube-system`
 */
interface ClusterAutoscalerArgs {
  awsAccountId: string,
  awsRegion: string,
  clusterName: pulumi.Output<string>,
  eksHash: pulumi.Output<string>,
}

export class ClusterAutoscaler extends pulumi.ComponentResource {
  constructor(name: string, args: ClusterAutoscalerArgs, opts: any) {
    super('custom:k8s:ClusterAutoscaler', name, {}, opts)

    const {
      awsAccountId,
      awsRegion,
      clusterName,
      eksHash,
    } = args

    const clusterAutoscalerNamespaceName = 'kube-system'
    const clusterAutoscalerReleaseName = 'cluster-autoscaler-release'
    // IMPORTANT: must match the sa name generated by the helm chart below
    const clusterAutoscalerSaName = `${clusterAutoscalerReleaseName}-aws-cluster-autoscaler`

    // IAM role for Cluster Autoscaler
    const clusterAutoscalerRoleName = 'AmazonEKSClusterAutoscalerRole'
    const clusterAutoscalerRole = new aws.iam.Role(clusterAutoscalerRoleName, {
      namePrefix: clusterAutoscalerRoleName,
      assumeRolePolicy: getClusterAutoscalerRoleTrustPolicy({
        awsRegion,
        awsAccountId,
        eksHash,
        namespace: clusterAutoscalerNamespaceName,
        serviceAccountName: clusterAutoscalerSaName,
      }),
    })
    const clusterAutoscalerPolicyName = 'AmazonEKSClusterAutoscalerPolicy'
    const clusterAutoscalerPolicy = new aws.iam.Policy(clusterAutoscalerPolicyName, {
      namePrefix: clusterAutoscalerPolicyName,
      description: 'Cluster Autoscaler policy',
      policy: getClusterAutoscalerPolicy(),
    })
    new aws.iam.RolePolicyAttachment(`cluster-autoscaler-role-policy`, {
      role: clusterAutoscalerRole,
      policyArn: clusterAutoscalerPolicy.arn,
    })

    // Set up Cluster Autoscaler via Helm
    const clusterAutoscaler = new k8s.helm.v3.Release(clusterAutoscalerReleaseName, {
      name: clusterAutoscalerReleaseName,
      namespace: clusterAutoscalerNamespaceName,
      chart: 'cluster-autoscaler',
      repositoryOpts: {
        repo: 'https://kubernetes.github.io/autoscaler',
      },
      values: {
        cloudProvider: 'aws',
        awsRegion,
        autoDiscovery: {
          clusterName,
        },
        rbac: {
          serviceAccount: {
            annotations: {
              'eks.amazonaws.com/role-arn': pulumi.interpolate`${clusterAutoscalerRole.arn}`
            }
          }
        },
      },
      cleanupOnFail: true,
    }, { parent: this })

    this.registerOutputs()
  }
}

interface RdsPostgresArgs {
  subnetIds: pulumi.Output<any>,
  vpcSecurityGroupIds: pulumi.Output<string>[],
  username: string,
  password: pulumi.Output<string>,
  instanceClass: string,
  allocatedStorage: number,
  maxAllocatedStorage: number,
}

export class RdsPostgres extends pulumi.ComponentResource {
  name: pulumi.Output<string>
  endpoint: pulumi.Output<string>
  port: pulumi.Output<number>

  constructor(name: string, args: RdsPostgresArgs, opts: any) {
    super('custom:aws:RdsPostgres', name, {}, opts)

    const {
      subnetIds,
      vpcSecurityGroupIds,
      username,
      password,
      instanceClass = 'db.t3.micro',
      allocatedStorage = 10,
      maxAllocatedStorage = 100,
    } = args

    // Set up db subnet group
    const dbSubnetGroup = new aws.rds.SubnetGroup('db-postgres-rds-subnet-group', {
      subnetIds,
    }, { parent: this })

    const rds = new aws.rds.Instance(name, {
      name,
      dbSubnetGroupName: dbSubnetGroup.name,
      vpcSecurityGroupIds,
      instanceClass,
      allocatedStorage,
      maxAllocatedStorage, // for autoscaling
      engine: 'postgres',
      engineVersion: '13.3',
      username,
      password,
      skipFinalSnapshot: true,
    }, { parent: this })

    this.name = rds.name
    this.endpoint = rds.endpoint
    this.port = rds.port

    this.registerOutputs()
  }
}

interface KnativeOperatorArgs {
  version: string,
}

export class KnativeOperator extends pulumi.ComponentResource {
  resources: pulumi.Output<{ [key: string]: pulumi.CustomResource; }>

  constructor(name: string, args: KnativeOperatorArgs, opts: any) {
    super('custom:k8s:KnativeOperator', name, {}, opts)

    const { version } = args

    // Install knative operator
    const knativeOperator = new k8s.yaml.ConfigGroup(name, {
      files: `https://github.com/knative/operator/releases/download/knative-v${version}/operator.yaml`,
    }, { parent: this })

    // // HACK: try locally
    // // Install knative operator
    // const knativeOperator = new k8s.yaml.ConfigGroup(name, {
    //   files: path.resolve(process.cwd(), 'src/pulumi/knative-operator.yaml'),
    // }, { parent: this })

    this.resources = knativeOperator.resources

    this.registerOutputs()
  }
}

interface KnativeServingArgs {
  customDomain: string,
  knativeHttpsIngressGatewayName: string,
  highAvailabilityReplicas?: number,
}

export class KnativeServing extends pulumi.ComponentResource {
  id: pulumi.Output<String>

  constructor(name: string, args: KnativeServingArgs, opts: any) {
    super('custom:k8s:KnativeServing', name, {}, opts)

    const {
      customDomain,
      knativeHttpsIngressGatewayName,
      highAvailabilityReplicas = 2,
    } = args

    const knativeServingNamespaceName = 'knative-serving'
    const knativeServingName = 'knative-serving'

    // Install knative serving component
    const knativeServingNamespace = new k8s.core.v1.Namespace(knativeServingNamespaceName, {
      metadata: { name: knativeServingNamespaceName }
    }, { parent: this })

    const knativeServing = new k8s.apiextensions.CustomResource(knativeServingName, {
      apiVersion: 'operator.knative.dev/v1alpha1',
      kind: 'KnativeServing',
      metadata: {
        name: knativeServingName,
        namespace: knativeServingNamespace.metadata.name,
      },
      spec: {
        config: { // you can edit all ConfigMaps in knative operator namespace here
          domain: { // set up a custom domain
            [customDomain]: '',
          },
          gc: { // keep around the last 20 non-active revisions
            'retain-since-create-time': 'disabled',
            'retain-since-last-active-time': 'disabled',
            'min-non-active-revisions': '4',
            'max-non-active-revisions': '6',
          },
          autoscaler: {
            // 'enable-scale-to-zero': 'false',
            'scale-to-zero-grace-period': '300s',
          },
          network: {
            autoTLS: 'Enabled', // requires cert-manager to be set up
            httpProtocol: 'Redirected', // redirects all http to https
          },
          certmanager: {
            issuerRef: '|\n  kind: ClusterIssuer\n  name: letsencrypt-dns-issuer\n',
          },
          istio: {
            [`gateway.knative-serving.${knativeHttpsIngressGatewayName}`]: 'istio-ingressgateway.istio-system.svc.cluster.local'
          },
        },
        'high-availability': {
          replicas: highAvailabilityReplicas
        },
      }
    }, { parent: this })

    this.id = knativeServing.id

    this.registerOutputs()
  }
}

export class KnativeEventing extends pulumi.ComponentResource {
  id: pulumi.Output<String>

  constructor(name: string, args: any, opts: any) {
    super('custom:k8s:KnativeEventing', name, {}, opts)

    const knativeEventingNamespaceName = 'knative-eventing'
    const knativeEventingName = 'knative-eventing'

    // Install knative serving component
    const knativeEventingNamespace = new k8s.core.v1.Namespace(knativeEventingNamespaceName, {
      metadata: { name: knativeEventingNamespaceName }
    }, { parent: this })

    const knativeEventing = new k8s.apiextensions.CustomResource(knativeEventingName, {
      apiVersion: 'operator.knative.dev/v1alpha1',
      kind: 'KnativeEventing',
      metadata: {
        name: knativeEventingName,
        namespace: knativeEventingNamespace.metadata.name,
      },
    }, { parent: this })

    this.id = knativeEventing.id

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
 * Replace default knative-ingress-gateway with knative-https-ingress-gateway to allow tls traffic
 */
interface KnativeHttpsIngressGatewayArgs {
  customDomain: string,
  knativeHttpsIngressGatewayName: string,
  wildcardCertificateSecretName: string,
}

export class KnativeHttpsIngressGateway extends pulumi.ComponentResource {
  id: pulumi.Output<String>
  name: String

  constructor(name: string, args: KnativeHttpsIngressGatewayArgs, opts: any) {
    super('custom:k8s:KnativeHttpsIngressGateway', name, {}, opts)

    const {
      customDomain,
      knativeHttpsIngressGatewayName,
      wildcardCertificateSecretName,
    } = args

    const knativeHttpsIngressGateway = new k8s.apiextensions.CustomResource(knativeHttpsIngressGatewayName, {
      apiVersion: 'networking.istio.io/v1beta1',
      kind: 'Gateway',
      metadata: {
        name: knativeHttpsIngressGatewayName,
        namespace: 'knative-serving',
      },
      spec: {
        selector: {
          istio: 'ingressgateway'
        },
        servers: [
          {
            hosts: ['*'],
            port: {
              name: 'http',
              number: 80,
              protocol: 'HTTP'
            },
            tls: {
              httpsRedirect: true
            }
          },
          {
            hosts: [`*.${customDomain}`],
            port: {
              name: 'https',
              number: 443,
              protocol: 'HTTPS'
            },
            tls: {
              credentialName: wildcardCertificateSecretName,
              mode: 'SIMPLE',
              privateKey: 'tls.key',
              serverCertificate: 'tls.crt'
            }
          },
        ]
      }
    }, { parent: this })

    this.id = knativeHttpsIngressGateway.id
    this.name = knativeHttpsIngressGatewayName

    this.registerOutputs()
  }
}

interface KnativeVirtualServiceArgs {
  useKnativeRouting?: boolean, // requires different VirtualService setup than usual Istio VirtualService for Knative svc - i.e. using host Header + knative-local-gateway
  namespace: string,
  gateways: string[],
  hosts: string[],
  routes: KnativeVirtualServiceRoute[],
}

interface KnativeVirtualServiceRoute {
  uri: string,
  rewriteUri: string,
  serviceHostname: string,
  port?: number,
  weight?: number,
}

export class KnativeVirtualService extends pulumi.ComponentResource {
  virtualService: k8s.apiextensions.CustomResource

  constructor(name: string, args: KnativeVirtualServiceArgs, opts: any) {
    super('custom:k8s:KnativeVirtualService', name, {}, opts)

    const {
      useKnativeRouting = false,
      namespace,
      gateways,
      hosts,
      routes,
    } = args

    this.virtualService = new k8s.apiextensions.CustomResource(name, {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'VirtualService',
      metadata: {
        namespace,
        name,
      },
      spec: {
        gateways,
        hosts, // Set host to the domain name that you own.
        http: routes.map(route => ({
          match: [
            {
              uri: {
                prefix: route.uri,
              }
            }
          ],
          // Rewrite the original host header to the host header of the service 
          // in order to redirect requests
          rewrite: {
            ...useKnativeRouting ? { authority: route.serviceHostname } : {},
            uri: route.rewriteUri,
          },
          // Basically here we redirect the request to the internal gateway with
          // updated header so the request will eventually be directed to the right service.
          route: [
            {
              destination: {
                host: useKnativeRouting ? `knative-local-gateway.istio-system.svc.cluster.local` : route.serviceHostname,
                port: {
                  number: route.port || 80,
                }
              },
              weight: route.weight || 100,
            }
          ]
        }))
      },
    }, { parent: this })

    this.registerOutputs()
  }
}

interface CertManagerArgs {
  awsAccountId: string,
  awsRegion: string,
  hostedZoneId: string,
  customDomain: string,
  eksHash: pulumi.Output<string>,
  acmeEmail: string,
}

export class CertManager extends pulumi.ComponentResource {
  constructor(name: string, args: CertManagerArgs, opts: any) {
    super('custom:k8s:CertManager', name, {}, opts)

    const {
      awsAccountId,
      awsRegion,
      hostedZoneId,
      customDomain,
      eksHash,
      acmeEmail,
    } = args

    const certManagerName = 'cert-manager'
    const certManagerNamespaceName = 'cert-manager'
    const certManagerNamespace = new k8s.core.v1.Namespace(certManagerNamespaceName, {
      metadata: { name: certManagerNamespaceName },
    }, { parent: this })

    const certManagerRoleName = 'cert-manager'
    const certManagerServiceAccountName = 'cert-manager'

    /**
     * Set up IAM role for cert-manager ServiceAccount
     */
    const certManagerRole = new aws.iam.Role(certManagerRoleName, {
      namePrefix: certManagerRoleName,
      path: '/',
      description: 'cert-manager role',
      assumeRolePolicy: getCertManagerRoleTrustPolicy({
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
        namespace: certManagerNamespaceName,
      },
      serviceAccount: {
        annotations: {
          'eks.amazonaws.com/role-arn': certManagerRoleArn,
        }
      },
      securityContext: {
        fsGroup: 1001,
      },
    }, { parent: this })
    // certManagerRoleArn.apply(t => console.log('certManagerRoleArn', t))

    /**
     * Set up ClusterIssuer (cluster level tls issuer)
     */
    const clusterIssuer = new k8s.apiextensions.CustomResource(`${name}-cluster-issuer`, {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: {
        name: 'letsencrypt-dns-issuer',
        namespace: certManagerNamespaceName,
      },
      spec: {
        acme: {
          // Let's Encrypt will use this to contact you about expiring
          // certificates, and issues related to your account.
          email: acmeEmail,
          // server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          privateKeySecretRef: {
            // Secret resource that will be used to store the account's private key.
            name: 'letsencrypt-pk-secret',
          },
          solvers: [{
            selector: {
              dnsZones: [customDomain]
            },
            dns01: {
              route53: {
                region: awsRegion,
                hostedZoneID: hostedZoneId,
              }
            }
          }]
        }
      }
    }, { parent: this, dependsOn: [certManager] })

    // Install net-certmanager-controller deployment
    const netCertManagerController = new k8s.yaml.ConfigGroup('net-certmanager-controller', {
      files: 'https://github.com/knative/net-certmanager/releases/download/v0.26.0/release.yaml',
    }, { parent: this, dependsOn: [certManager] })

    // Install net-nscert-controller component
    const netNscertController = new k8s.yaml.ConfigGroup('net-nscert-controller', {
      files: 'https://github.com/knative/serving/releases/download/v0.26.0/serving-nscert.yaml',
    }, { parent: this, dependsOn: [certManager] })

    this.registerOutputs()
  }
}

interface WildcardCertificateArgs {
  customDomain: string,
  wildcardCertificateSecretName: string,
}

export class WildcardCertificate extends pulumi.ComponentResource {
  secretName: string

  constructor(name: string, args: WildcardCertificateArgs, opts: any) {
    super('custom:k8s:WildcardCertificate', name, {}, opts)

    const {
      customDomain,
      wildcardCertificateSecretName,
    } = args

    const wildcardDomain = `*.${customDomain}`
    const cert = new k8s.apiextensions.CustomResource(name, {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name,
        namespace: 'istio-system',
      },
      spec: {
        secretName: wildcardCertificateSecretName,
        duration: '2160h', // 90d
        renewBefore: '360h', // 15d
        issuerRef: {
          kind: 'ClusterIssuer',
          name: 'letsencrypt-dns-issuer',
        },
        commonName: wildcardDomain,
        dnsNames: [wildcardDomain],
      }
    }, { parent: this })

    this.secretName = wildcardDomain

    this.registerOutputs()
  }
}

/**
 * Set up Kube Prometheus Stack (including Prometheus, Grafana, Alert Manager, etc)
 */
interface KubePrometheusStackArgs {
  kubePrometheusStackNamespaceName: string,
  grafanaUser: string,
  grafanaPassword: pulumi.Output<string>,
}

export class KubePrometheusStack extends pulumi.ComponentResource {
  constructor(name: string, args: KubePrometheusStackArgs, opts: any) {
    super('custom:k8s:KubePrometheusStack', name, {}, opts)

    const {
      kubePrometheusStackNamespaceName,
      grafanaUser,
      grafanaPassword,
    } = args

    const kubePrometheusStackNamespace = new k8s.core.v1.Namespace(kubePrometheusStackNamespaceName, {
      metadata: { name: kubePrometheusStackNamespaceName },
    }, { parent: this })

    const grafanaAccessSecretName = 'grafana-access-secret'
    const grafanaAccessSecret = new k8s.core.v1.Secret(grafanaAccessSecretName, {
      metadata: {
        name: grafanaAccessSecretName,
        namespace: kubePrometheusStackNamespace.metadata.name,
      },
      stringData: {
        'admin-user': grafanaUser,
        'admin-password': grafanaPassword,
      }
    }, { parent: this })

    const kubePrometheusStackReleaseName = `${name}`
    const kubePrometheusStack = new k8s.helm.v3.Release(kubePrometheusStackReleaseName, {
      skipCrds: false, // set `skipCrds: true` if you encounter `error: rendered manifests contain a resource that already exists.`
      name: kubePrometheusStackReleaseName,
      namespace: kubePrometheusStackNamespace.metadata.name,
      chart: 'kube-prometheus-stack',
      repositoryOpts: {
        repo: 'https://prometheus-community.github.io/helm-charts',
      },
      values: {
        // See list of all values: https://github.com/prometheus-community/helm-charts/blob/main/charts/kube-state-metrics/values.yaml
        'kube-state-metrics': {
          'metricLabelsAllowlist': [
            'pods=[*]',
            'deployments=[app.kubernetes.io/name,app.kubernetes.io/component,app.kubernetes.io/instance]'
          ],
        },
        // See list of all values: https://github.com/prometheus-community/helm-charts/blob/main/charts/kube-prometheus-stack/values.yaml
        prometheus: {
          prometheusSpec: {
            serviceMonitorSelectorNilUsesHelmValues: false,
            podMonitorSelectorNilUsesHelmValues: false,
          },
        },
        // See list of all values: https://github.com/grafana/helm-charts/blob/main/charts/grafana/values.yaml
        grafana: {
          sidecar: {
            dashboards: {
              enabled: true,
              searchNamespace: 'ALL',
            }
          },
          admin: {
            existingSecret: grafanaAccessSecret.metadata.name,
            userKey: 'admin-user',
            passwordKey: 'admin-password',
          }
        },
      },
      cleanupOnFail: true,
    }, { parent: this })

    this.registerOutputs()
  }
}

export class KnativeServiceMonitors extends pulumi.ComponentResource {
  constructor(name: string, args: any, opts: any) {
    super('custom:k8s:KnativeServiceMonitors', name, {}, opts)

    // Apply the ServiceMonitors/PodMonitors to collect metrics from Knative
    const serviceMonitorsName = 'service-monitors'
    const serviceMonitors = new k8s.yaml.ConfigGroup(serviceMonitorsName, {
      files: 'https://raw.githubusercontent.com/knative-sandbox/monitoring/main/servicemonitor.yaml',
    }, { parent: this })

    this.registerOutputs()
  }
}

export class KnativeGrafanaDashboards extends pulumi.ComponentResource {
  constructor(name: string, args: any, opts: any) {
    super('custom:k8s:KnativeGrafanaDashboards', name, {}, opts)

    // Import Grafana dashboards 
    const grafanaDashboardsName = 'grafana-dashboards'
    const grafanaDashboards = new k8s.yaml.ConfigGroup(grafanaDashboardsName, {
      files: 'https://raw.githubusercontent.com/knative-sandbox/monitoring/main/grafana/dashboards.yaml',
    }, { parent: this })

    this.registerOutputs()
  }
}