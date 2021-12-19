import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import { Karpenter } from '../component-resources'

export interface KarpenterStackArgs {
  awsAccountId: string,
  awsRegion: string,
  clusterName: pulumi.Output<string>,
  clusterEndpoint: pulumi.Output<any>,
  nodeGroupRole: aws.iam.Role,
  eksHash: pulumi.Output<string>,
}

export class KarpenterStack extends pulumi.ComponentResource {
  constructor(name: string, args: KarpenterStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:KarpenterStack', name, {}, opts)

    const {
      awsAccountId,
      awsRegion,
      clusterName,
      clusterEndpoint,
      nodeGroupRole,
      eksHash,
    } = args

    const karpenter = new Karpenter(`karpenter-${clusterName}`, {
      awsAccountId,
      awsRegion,
      clusterName,
      clusterEndpoint,
      nodeGroupRole,
      eksHash,
    }, { parent: this })

    this.registerOutputs()
  }
}