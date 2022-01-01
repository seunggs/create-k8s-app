import * as pulumi from '@pulumi/pulumi'
import { CertManager } from '../component-resources/cluster-svc'

export interface CertManagerStackArgs {
  project: string,
  awsAccountId: string,
  awsRegion: string,
  // hostedZoneId: string,
  certManagerNamespaceName: string,
  eksHash: pulumi.Output<string>,
}

export class CertManagerStack extends pulumi.ComponentResource {
  constructor(name: string, args: CertManagerStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:CertManagerStack', name, {}, opts)

    const {
      project,
      awsAccountId,
      awsRegion,
      // hostedZoneId,
      certManagerNamespaceName,
      eksHash,
    } = args

    // Install cert-manager for TLS certificates
    const certManager = new CertManager('cert-manager', {
      project,
      awsAccountId,
      awsRegion,
      // hostedZoneId,
      certManagerNamespaceName,
      eksHash,
    }, { parent: this })

    this.registerOutputs()
  }
}