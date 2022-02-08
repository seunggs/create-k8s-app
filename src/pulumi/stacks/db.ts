import * as pulumi from '@pulumi/pulumi'
import * as awsx from '@pulumi/awsx'
import { RdsPostgres } from '../component-resources/app'

export interface DbStackArgs {
  dbName: string,
  dbUser: string,
  dbPassword: pulumi.Output<string>,
  vpc: awsx.ec2.Vpc,
  vpcPublicSubnetIds: pulumi.Output<any>,
  instanceClass?: string,
  allocatedStorage?: number,
  maxAllocatedStorage?: number,
}

export class DbStack extends pulumi.ComponentResource {
  rdsName: pulumi.Output<string>
  rdsEndpoint: pulumi.Output<string>

  constructor(name: string, args: DbStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:DbStack', name, {}, opts)

    const {
      dbName,
      dbUser,
      dbPassword,
      vpc,
      vpcPublicSubnetIds,
      instanceClass = 'db.t3.micro',
      allocatedStorage = 5,
      maxAllocatedStorage = 20,
    } = args

    /**
     * Set up RDS
     */
    const rdsPostgres = new RdsPostgres(dbName, {
      vpc,
      subnetIds: vpcPublicSubnetIds, // TODO: less secure
      // subnetIds: vpc.privateSubnetIds, // so it's NOT accessible from outside the VPC
      username: dbUser,
      password: dbPassword,
      instanceClass,
      allocatedStorage,
      maxAllocatedStorage,
    }, { protect: true })

    this.rdsName = rdsPostgres.name
    this.rdsEndpoint = rdsPostgres.endpoint

    this.registerOutputs()
  }
}