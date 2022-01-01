import * as path from 'path'
import * as pulumi from '@pulumi/pulumi'
import * as awsx from '@pulumi/awsx'
import * as k8s from '@pulumi/kubernetes'
import { AppAutoscaleStep, AppBuildStep, AppDeployStep, K8sContainerEnvVar } from '../component-resources/app'

export interface AppStackImageArgs {
  name: string,
  context: string,
  dockerfile: string,
}

export interface AppStackContainerArgs {
  port: number,
  envs?: K8sContainerEnvVar[],
  resources?: any,
}

export interface AppStackArgs {
  projectRootPath: string,
  appSvcName: string,
  appNamespaceName: string,
  image: AppStackImageArgs,
  container: AppStackContainerArgs,
}

export class AppStack extends pulumi.ComponentResource {
  constructor(name: string, args: AppStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:AppStack', name, {}, opts)

    const {
      projectRootPath,
      appSvcName,
      appNamespaceName,
      image: {
        name: imageName,
        context,
        dockerfile,
      },
      container: {
        port,
        envs,
        resources,
      },
    } = args

    require('dotenv').config({ path: path.resolve(projectRootPath, '.env') })

    // NOTE: these frontend envs should also be manually included in Dockerfile
    const frontendEnvsAsArgs = {}

    // Build app - name is used as ECR repo name
    const { imageUrl } = new AppBuildStep(imageName, {
      context,
      dockerfile,
      args: frontendEnvsAsArgs,
    }, { parent: this })

    // Deploy app svc
    const appDeployStep = new AppDeployStep(appSvcName, {
      namespace: appNamespaceName,
      svcName: appSvcName,
      container: {
        image: imageUrl,
        port, 
        ...envs ? { envs } : {},
        ...resources ? { resources } : {},
      }
    }, { parent: this })

    const appAutoscaleStep = new AppAutoscaleStep(appSvcName, {
      targetDeploymentName: appSvcName,
      targetDeploymentNamespace: appNamespaceName,
    }, { parent: this })

    this.registerOutputs()
  }
}