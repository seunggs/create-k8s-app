import * as pulumi from '@pulumi/pulumi'
import { Emissary, EmissaryListener, Hpa } from '../component-resources/cluster-svc'

interface EmissaryStackArgs {
  emissaryNamespaceName: string,
}

export class EmissaryStack extends pulumi.ComponentResource {
  constructor(name: string, args: EmissaryStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:EmissaryStack', name, {}, opts)

    const { emissaryNamespaceName } = args

    const emissary = new Emissary('emissary', {
      emissaryNamespaceName,
    }, { parent: this })

    const emissaryListener = new EmissaryListener(`emissary-listener`, {
      namespace: emissaryNamespaceName,
    }, { parent: this, dependsOn: [emissary] })

    const emissaryIngressHpa = new Hpa('emissary-ingress', {
      targetDeploymentName: 'emissary-ingress',
      targetDeploymentNamespace: 'emissary',
    })

    this.registerOutputs()
  }
}