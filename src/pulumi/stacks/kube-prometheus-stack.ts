import * as pulumi from '@pulumi/pulumi'
import { KubePrometheusStack } from '../component-resources/monitoring'
import { EmissaryHost, EmissaryMapping } from '../component-resources/cluster-svc'

export interface KubePrometheusStackStackArgs {
  kubePrometheusStackNamespaceName: string,
  grafanaUser: string,
  grafanaPassword: pulumi.Output<string>,
  hostname: string,
  emissaryNamespaceName: string,
  tlsSecretName: string,
  qualifiedSvcName: string,
}

export class KubePrometheusStackStack extends pulumi.ComponentResource {
  constructor(name: string, args: KubePrometheusStackStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:KubePrometheusStackStack', name, {}, opts)

    const {
      kubePrometheusStackNamespaceName,
      grafanaUser,
      grafanaPassword,
      hostname,
      emissaryNamespaceName,
      tlsSecretName,
      qualifiedSvcName,
    } = args

    /**
     * Set up Kube Prometheus Stack (end-to-end k8s monitoring using prometheus, grafana, etc)
     */
    const kubePrometheusStack = new KubePrometheusStack(`kube-prometheus-stack`, {
      kubePrometheusStackNamespaceName,
      grafanaUser,
      grafanaPassword,
    }, { parent: this })

    /**
     * Expose Grafana Dashboard as a separate subdomain
     */
    const namePrefix = 'grafana'
    const grafanaHost = new EmissaryHost(`${namePrefix}-host`, {
      namePrefix,
      namespace: emissaryNamespaceName,
      hostname,
      tlsSecretName,
    }, { parent: this })

    const grafanaMapping = new EmissaryMapping(`${namePrefix}-mapping`, {
      namespace: emissaryNamespaceName,
      hostname,
      prefix: '/',
      qualifiedSvcName,
    }, { parent: this })

    this.registerOutputs()
  }
}