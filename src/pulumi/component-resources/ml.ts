import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { EmissaryHost, EmissaryMapping } from './cluster-svc'

interface JupyterhubArgs {
  jupyterhubNamespaceName: string,
  emissaryNamespaceName: string,
  hostname: string,
  tlsSecretName: string,
  qualifiedSvcName: string,
}

export class Jupyterhub extends pulumi.ComponentResource {
  constructor(name: string, args: JupyterhubArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:ml:Jupyterhub', name, {}, opts)

    const {
      jupyterhubNamespaceName,
      emissaryNamespaceName,
      hostname,
      tlsSecretName,
      qualifiedSvcName,
    } = args
    
    const jupyterhubNamespace = new k8s.core.v1.Namespace(jupyterhubNamespaceName, {
      metadata: { name: jupyterhubNamespaceName }
    }, { parent: this })

    const jupyterhubReleaseName = 'jupyterhub'
    const jupyterhubRelease = new k8s.helm.v3.Release(jupyterhubReleaseName, {
      name: jupyterhubReleaseName,
      namespace: jupyterhubNamespace.metadata.name,
      chart: 'jupyterhub',
      repositoryOpts: {
        repo: 'https://jupyterhub.github.io/helm-chart/',
      },
      cleanupOnFail: true,
    }, { parent: this })

    /**
     * Expose Jupyterhub as a separate subdomain
     */
    const namePrefix = 'jupyterhub'
    const jupyterhubHost = new EmissaryHost(`${namePrefix}-host`, {
      namePrefix,
      namespace: emissaryNamespaceName,
      hostname,
      tlsSecretName,
    }, { parent: this })

    const jupyterhubMapping = new EmissaryMapping(`${namePrefix}-mapping`, {
      namespace: emissaryNamespaceName,
      hostname,
      prefix: '/',
      qualifiedSvcName,
    }, { parent: this })

    this.registerOutputs()
  }
}
