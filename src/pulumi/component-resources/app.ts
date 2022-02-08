import * as path from 'path'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'
import * as k8s from '@pulumi/kubernetes'

interface RdsPostgresArgs {
  vpc: awsx.ec2.Vpc,
  subnetIds: pulumi.Output<any>,
  username: string,
  password: pulumi.Output<string>,
  instanceClass: string,
  allocatedStorage: number,
  maxAllocatedStorage: number,
}

export class RdsPostgres extends pulumi.ComponentResource {
  name: pulumi.Output<string>
  endpoint: pulumi.Output<string>
  port: number

  constructor(name: string, args: RdsPostgresArgs, opts: any) {
    super('custom:aws:RdsPostgres', name, {}, opts)

    const {
      vpc,
      subnetIds,
      username,
      password,
      instanceClass = 'db.t3.small',
      allocatedStorage = 10,
      maxAllocatedStorage = 100,
    } = args

    /**
     * VPC Security Group for RDS
     */
    const sgRds = new awsx.ec2.SecurityGroup(`rds-${name}`, { vpc })
    awsx.ec2.SecurityGroupRule.ingress('postgres-access', sgRds,
      new awsx.ec2.AnyIPv4Location(),
      new awsx.ec2.TcpPorts(5432),
      'allow all postgres access'
    )
    awsx.ec2.SecurityGroupRule.ingress('ssh-access', sgRds,
      new awsx.ec2.AnyIPv4Location(),
      new awsx.ec2.TcpPorts(22),
      'allow ssh access'
    )

    // Set up db subnet group
    const dbSubnetGroup = new aws.rds.SubnetGroup(`rds-${name}-postgres-subnet-group`, { subnetIds }, { parent: this })

    const rds = new aws.rds.Instance(name, {
      name,
      dbSubnetGroupName: dbSubnetGroup.name,
      vpcSecurityGroupIds: [sgRds.id], // so it's accessible from another instance inside the cluster
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
    this.port = 5432

    this.registerOutputs()
  }
}

/**
 * Deployment + Service
 */
export interface K8sObjectMeta {
  name?: string,
  namespace?: string | pulumi.Output<string>,
  labels?: any,
  annotations?: any,
}

export interface K8sContainerEnvVar {
  name: string,
  value?: string | pulumi.Output<string>,
  valueFrom?: any,
}

export interface K8sServiceDeploymentVolume {
  name: string,
  mountPath: string,
  claimName: string,
}

export interface K8sContainerResourceRequirements {
  limits?: { [key: string]: string },
  requests?: { [key: string]: string },
}

export interface K8sContainer {
  name?: string,
  args?: string[],
  command?: string[],
  env?: K8sContainerEnvVar[],
  image: pulumi.Output<string> | string,
  imagePullPolicy?: string,
  resources?: K8sContainerResourceRequirements,
  port: number,
}

export interface ServiceDeploymentArgs {
  replicas?: number,
  metadata?: K8sObjectMeta,
  podMetadata?: K8sObjectMeta,
  container: K8sContainer,
  volumes?: K8sServiceDeploymentVolume[],
  serviceType?: string,
  servicePort?: number,
}

export class ServiceDeployment extends pulumi.ComponentResource {
  deployment: k8s.apps.v1.Deployment
  service: k8s.core.v1.Service
  url: pulumi.Output<string>

  constructor(name: string, args: ServiceDeploymentArgs, opts: any) {
    super('custom:k8s:ServiceDeployment', name, {}, opts)

    const {
      replicas = 1,
      metadata: {
        name: appName = name,
        namespace = 'default',
        labels: customLabels = {},
        annotations,
      } = {},
      podMetadata: {
        annotations: podAnnotations,
      } = {},
      container: {
        image,
        args: containerArgs,
        env,
        command,
        resources = {
          requests: {
            cpu: '1',
            memory: '2Gi'
          }
        },
        port: containerPort,
      },
      volumes = [],
      serviceType = 'ClusterIP',
      servicePort = 80,
    } = args

    const container = {
      name: appName,
      image: image instanceof awsx.ecr.RepositoryImage ? image.image() : image,
      ...containerArgs ? { containerArgs } : {},
      ...env ? { env } : {},
      resources,
      command,
      ports: [{ containerPort }],
      volumeMounts: volumes && volumes.map(volume => ({
        name: volume.name,
        mountPath: volume.mountPath,
      })),
    }

    const labels = { app: appName, ...customLabels }

    this.deployment = new k8s.apps.v1.Deployment(name, {
      metadata: {
        name: appName,
        namespace,
        labels,
        ...annotations ? { annotations } : {},
      },
      spec: {
        replicas,
        selector: {
          matchLabels: labels,
        },
        template: {
          metadata: {
            labels,
            ...podAnnotations ? { annotations: podAnnotations } : {},
          },
          spec: {
            containers: [container],
            volumes: volumes && volumes.map(volume => ({
              name: volume.name,
              PersistentVolumeClaim: {
                claimName: volume.claimName,
              }
            })),
          }
        },
      },
    }, { parent: this })

    this.service = new k8s.core.v1.Service(name, {
      metadata: {
        name: appName,
        namespace,
        labels,
        annotations,
      },
      spec: {
        type: serviceType,
        ports: [{ port: servicePort, targetPort: containerPort }],
        selector: labels,
      },
    }, { parent: this })

    const address = this.service.status.loadBalancer.ingress[0].hostname
    const port = this.service.spec.ports[0].port
    this.url = pulumi.interpolate`http://${address}:${port}`

    this.registerOutputs()
  }
}

interface DaprServiceArgs extends ServiceDeploymentArgs {
  daprAppId: string,
}

export class DaprService extends pulumi.ComponentResource {
  url: pulumi.Output<string>

  constructor(name: string, args: DaprServiceArgs, opts: any) {
    super('custom:k8s:DaprService', name, {}, opts)

    // GOTCHA: it will block until the app listening is on daprAppPort
    // i.e make sure daprAppPort = app port (i.e. port where the server is listening on)
    const { daprAppId, container: { port } } = args

    const daprService = new ServiceDeployment(name, {
      ...args,
      podMetadata: {
        ...args.podMetadata || {},
        annotations: {
          ...args.podMetadata ? args.podMetadata.annotations : {},
          // 'dapr.io/log-level': 'debug',
          'dapr.io/enabled': 'true',
          'dapr.io/app-id': daprAppId,
          'dapr.io/app-port': port.toString(),
        }
      }
    }, opts)

    this.url = daprService.url

    this.registerOutputs()
  }
}

export interface DaprJobArgs {
  namespaceName: string,
  container: K8sContainer,
}

export class DaprJob extends pulumi.ComponentResource {
  constructor(name: string, args: DaprJobArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:k8s:DaprJob', name, {}, opts)

    const {
      namespaceName,
      container: {
        image,
        args: containerArgs,
        env,
        command,
        resources = {
          requests: {
            cpu: '1',
            memory: '2Gi'
          }
        },
        port: containerPort,
      },
    } = args

    const container = {
      name,
      image: image instanceof awsx.ecr.RepositoryImage ? image.image() : image,
      ...containerArgs ? { containerArgs } : {},
      ...env ? { env } : {},
      resources,
      command,
    }

    const job = new k8s.batch.v1.Job(name, {
      metadata: {
        name,
        namespace: namespaceName,
      },
      spec: {
        ttlSecondsAfterFinished: 100, // destory the Job/pods 100s after completion
        template: {
          metadata: {
            annotations: {
              'dapr.io/enabled': 'true',
              'dapr.io/app-id': name,
            },
          },
          spec: {
            containers: [container],
            restartPolicy: 'Never',
          },
        },
        backoffLimit: 4,
      },
    })
    this.registerOutputs()
  }
}

interface AwsSecretArgs {
  secretsObj: { [key: string]: string },
}

export class AwsSecret extends pulumi.ComponentResource {
  id: pulumi.Output<string>
  arn: pulumi.Output<string>

  constructor(name: string, args: AwsSecretArgs, opts: any) {
    super('custom:aws:AwsSecret', name, {}, opts)

    const { secretsObj } = args

    const secret = new aws.secretsmanager.Secret(name, { name })

    new aws.secretsmanager.SecretVersion(`${name}-version`, {
      secretId: secret.id,
      secretString: JSON.stringify(secretsObj),
    })

    this.id = secret.id
    this.arn = secret.arn

    this.registerOutputs()
  }
}

export interface AppBuildStepArgs {
  context: string,
  dockerfile: string,
  args?: { [key: string]: string },
}

export class AppBuildStep extends pulumi.ComponentResource {
  imageUrl: pulumi.Output<string> | string

  constructor(name: string, args: AppBuildStepArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:app:AppBuildStep', name, {}, opts)

    const {
      context,
      dockerfile,
      args: imageArgs,
    } = args

    // const image = 'docker.io/datawire/quote:0.5.0' // FOR TESTING

    // Build and push images to ECR
    const image = pulumi.output(awsx.ecr.buildAndPushImage(name, {
      context,
      dockerfile,
      args: imageArgs,
    }).imageValue)

    this.imageUrl = image

    this.registerOutputs()
  }
}

export interface AppDeployStepContainerArgs {
  image: pulumi.Output<string> | string,
  port: number,
  envs?: K8sContainerEnvVar[],
  resources?: any,
}

export interface AppDeployStepArgs {
  namespace: string,
  svcName: string,
  container: AppDeployStepContainerArgs,
}

export class AppDeployStep extends pulumi.ComponentResource {
  constructor(name: string, args: AppDeployStepArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:app:AppDeployStep', name, {}, opts)

    const {
      namespace,
      svcName,
      container: {
        image,
        port,
        envs,
        resources,
      },
    } = args

    const appSvc = new DaprService(svcName, {
      daprAppId: svcName,
      replicas: 1,
      metadata: {
        name: svcName,
        namespace: namespace,
      },
      container: {
        image,
        port,
        ...envs ? { env: envs } : {},
        ...resources ? { resources } : {},
      },
    }, { parent: this })

    this.registerOutputs()
  }
}