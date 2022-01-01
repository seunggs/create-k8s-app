import * as path from 'path'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'
import * as k8s from '@pulumi/kubernetes'
import { simpleStore } from './pulumi/store'
import { objToContainerEnvs } from './pulumi/helpers'

const cwd = process.cwd() // dir where the cli is run (i.e. project root)
const cliExecCtx = simpleStore.getState('cliExecutionContext')
const cliOptions = simpleStore.getState('cliOptions')

const main = async () => {
  // console.log('cli execution context', cliExecCtx)
  const config = new pulumi.Config()

  const project = pulumi.getProject()
  const projectRootPath = cliExecCtx === 'ckc' ? cwd : path.resolve(__dirname)
  const stack = cliExecCtx === 'ckc' ? simpleStore.getState('currentStack') : pulumi.getStack()
  const organization = config.require('pulumi_organization')
  const { accountId: awsAccountId } = await aws.getCallerIdentity({})
  const { name: awsRegion } = await aws.getRegion()

  const appStagingNamespaceName = 'app-staging'
  const appProdNamespaceName = 'app-prod'
  const kubePrometheusStackNamespaceName = 'kube-prometheus-stack'
  const rootDomainTlsSecretName = `tls-root-domain`
  const subdomainWildcardTlsSecretName = `tls-subdomain-wildcard`
  const appStagingSvcName = 'app-staging-svc'
  const appProdSvcName = 'app-prod-svc'
  const emissaryNamespaceName = 'emissary'
  const certManagerNamespaceName = 'cert-manager'

  // DB helpers
  const getDbStackOutputs = (config: pulumi.Config, dbStackRef: any) => {
    const dbUser = config.require('db_user')
    const dbPassword = config.requireSecret('db_password').apply(password => password)
    const dbName = dbStackRef.getOutput('rdsName') as pulumi.Output<string>
    const dbEndpoint = dbStackRef.getOutput('rdsEndpoint') as pulumi.Output<string>
    const dbPort = dbStackRef.getOutput('rdsPort') as pulumi.Output<number>
    return { dbUser, dbPassword, dbName, dbEndpoint, dbPort }
  }

  /**
   * Stack: dev
   */
  if (stack === 'dev') {
    const { DevStack } = require('./pulumi/stacks/dev')
    const devStackOutput = new DevStack('dev-stack', {
      projectRootPath,
      config,
      project,
      stackEnv: stack,
    })

    return devStackOutput
  }

  /**
   * Stack: identity
   */
  if (stack === 'identity') {
    const { IdentityStack } = await import('./pulumi/stacks/identity')
    const identityStackOutput = new IdentityStack('cluster-stack', {
      awsAccountId,
    })

    return identityStackOutput
  }

  const identityStackRef = new pulumi.StackReference(`${organization}/${project}/identity`)

  /**
   * Stack: cluster
   */
  if (stack === 'cluster') {
    const keyPairName = config.get('key_pair_name')
    const encryptionConfigKeyArn = config.get('encryption_config_key_arn')

    const clusterAdminRole = identityStackRef.getOutput('clusterAdminRole') as unknown as aws.iam.Role
    const developerRole = identityStackRef.getOutput('developerRole') as unknown as aws.iam.Role

    const { ClusterStack } = await import('./pulumi/stacks/cluster')
    const clusterStackOutput = new ClusterStack('cluster-stack', {
      project,
      clusterAdminRole,
      developerRole,
      ...keyPairName ? { keyPairName } : {},
      ...encryptionConfigKeyArn ? { encryptionConfigKeyArn } : {},
    })

    return clusterStackOutput
  }

  const clusterStackRef = new pulumi.StackReference(`${organization}/${project}/cluster`)
  const vpc = await clusterStackRef.getOutputValue('vpc') as unknown as awsx.ec2.Vpc
  const vpcPublicSubnetIds = await clusterStackRef.getOutputValue('vpcPublicSubnetIds')
  const kubeconfig = await clusterStackRef.getOutputValue('kubeconfig') as pulumi.Output<any>
  const k8sProvider = new k8s.Provider('k8s-provider', { kubeconfig })

  /**
   * Stack: karpenter
   */
  if (stack === 'karpenter') {
    const clusterName = await clusterStackRef.getOutputValue('clusterName')
    const clusterEndpoint = await clusterStackRef.getOutputValue('clusterEndpoint')
    const nodeGroupRole = await clusterStackRef.getOutputValue('nodeGroupRole') as unknown as aws.iam.Role
    const eksHash = await clusterStackRef.getOutputValue('eksHash') as pulumi.Output<string>

    const { KarpenterStack } = await import('./pulumi/stacks/karpenter')
    const karpenterStackOutput = new KarpenterStack('karpenter-stack', {
      awsAccountId,
      awsRegion,
      clusterName,
      clusterEndpoint,
      nodeGroupRole,
      eksHash,
    }, { provider: k8sProvider })

    return karpenterStackOutput
  }

  /**
   * Stack: cert-manager
   */
  if (stack === 'cert-manager') {
    // const hostedZoneId = config.require('hosted_zone_id')
    const eksHash = clusterStackRef.getOutput('eksHash') as pulumi.Output<string>

    const { CertManagerStack } = await import('./pulumi/stacks/cert-manager')
    const certManagerStackOutput = new CertManagerStack('cert-manager-stack', {
      project,
      awsAccountId,
      awsRegion,
      // hostedZoneId,
      certManagerNamespaceName,
      eksHash,
    }, { provider: k8sProvider })

    return certManagerStackOutput
  }

  /**
   * Stack: emissary
   */
  if (stack === 'emissary') {
    const { EmissaryStack } = await import('./pulumi/stacks/emissary')
    const emissaryStackOutput = new EmissaryStack('emissary-stack', {
      emissaryNamespaceName,
    }, { provider: k8sProvider })
    return emissaryStackOutput
  }

  /**
   * Stack: tls
   */
  if (stack === 'tls') {
    const hostname = config.require('hostname')
    const acmeEmail = config.require('acme_email')

    const { TlsStack } = await import('./pulumi/stacks/tls')
    const tlsStackOutput = new TlsStack('tls-stack', {
      awsRegion,
      acmeEmail,
      emissaryNamespaceName,
      certManagerNamespaceName,
      hostnames: [hostname],
      rootDomainTlsSecretName,
      subdomainWildcardTlsSecretName,
    }, { provider: k8sProvider })
    return tlsStackOutput
  }

  /**
   * Stack: dapr
   */
  if (stack === 'dapr') {
    const { DaprStack } = await import('./pulumi/stacks/dapr')
    const daprStackOutput = new DaprStack('dapr-stack', {}, { provider: k8sProvider })
    return daprStackOutput
  }

  /**
   * Stack: kube-prometheus-stack
   */
  if (stack === 'kube-prometheus-stack') {
    const grafanaHostname = config.require('hostname')
    const grafanaUser = config.require('grafana_user')
    const grafanaPassword = config.requireSecret('grafana_password').apply(password => password)

    const { KubePrometheusStackStack } = await import('./pulumi/stacks/kube-prometheus-stack')
    const kubePrometheusStackStackOutput = new KubePrometheusStackStack('kube-prometheus-stack-stack', {
      kubePrometheusStackNamespaceName,
      grafanaUser,
      grafanaPassword,
      hostname: grafanaHostname,
      emissaryNamespaceName,
      tlsSecretName: subdomainWildcardTlsSecretName,
      qualifiedSvcName: `kube-prometheus-stack-grafana.${kubePrometheusStackNamespaceName}`,
    }, { provider: k8sProvider })

    return kubePrometheusStackStackOutput
  }

  // /**
  //  * Stack: db-staging
  //  */
  // if (stack === 'db-staging') {
  //   const dbUser = config.require('db_user')
  //   const dbPassword = config.requireSecret('db_password').apply(password => password)

  //   const { DbStack } = await import('./pulumi/stacks/db')
  //   const dbStagingStackOutput = new DbStack('db-staging-stack', {
  //     dbUser,
  //     dbPassword,
  //     stackEnv: 'staging',
  //     appNamespaceName: appStagingNamespaceName,
  //     vpc,
  //     vpcPublicSubnetIds,
  //   }, { provider: k8sProvider })

  //   return dbStagingStackOutput
  // }

  // const dbStagingStackRef = new pulumi.StackReference(`${organization}/${project}/db-staging`)

  /**
   * Stack: app-init
   */
  if (stack === 'app-staging-init') {
    const developerClusterRole = await clusterStackRef.getOutputValue('developerClusterRole')

    const { AppInitStack } = await import('./pulumi/stacks/app-init')
    const identityStackOutput = new AppInitStack('cluster-stack', {
      appNamespaceName: appStagingNamespaceName,
      developerClusterRole,
    })
    return identityStackOutput
  }

  /**
   * Stack: app-staging
   */
  if (stack === 'app-staging') {
    const stackEnv = 'staging'
    // const dbStackOutputs = dbStagingStackRef ? getDbStackOutputs(config, dbStagingStackRef) : {}
    // const dbContainerEnvs = objToContainerEnvs(dbStackOutputs)

    const { AppStack } = await import('./pulumi/stacks/app')
    const appStackOutput = new AppStack(`app-${stackEnv}-stack`, {
      projectRootPath,
      appSvcName: appStagingSvcName, // must be unique,
      appNamespaceName: appStagingNamespaceName,
      image: {
        name: `${project}-${stackEnv}-app-image`,
        context: projectRootPath,
        dockerfile: './Dockerfile.prod',
      },
      container: {
        port: 4000, // GOTCHA: containerPort must match the port of the server running in the container
        // envs: dbContainerEnvs,
      }
    }, { provider: k8sProvider })

    return appStackOutput
  }

  /**
   * Stack: app-staging-ingress
   */
  if (stack === 'app-staging-ingress') {
    const stagingHostname = config.require('hostname')

    const { AppIngressStack } = await import('./pulumi/stacks/app-ingress')
    const appStagingIngressStackOutput = new AppIngressStack('app-staging-ingress-stack', {
      namePrefix: 'app-staging',
      emissaryNamespaceName,
      hostname: stagingHostname,
      tlsSecretName: subdomainWildcardTlsSecretName,
      qualifiedSvcName: `${appStagingSvcName}.${appStagingNamespaceName}`,
    }, { provider: k8sProvider })

    return appStagingIngressStackOutput
  }

  return {
    project,
    stack,
  }
}

export = main