import * as pulumi from '@pulumi/pulumi'
import * as awsx from '@pulumi/awsx'
import * as eks from '@pulumi/eks'
import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'

export interface ClusterStackArgs {
  project: string,
  clusterAdminRole: aws.iam.Role,
  developerRole: aws.iam.Role,
  keyPairName?: string,
  encryptionConfigKeyArn?: string, // AWS KMS Key ARN to use with the encryption configuration for the cluster (https://aws.amazon.com/about-aws/whats-new/2020/03/amazon-eks-adds-envelope-encryption-for-secrets-with-aws-kms/)
}

export class ClusterStack extends pulumi.ComponentResource {
  vpc: awsx.ec2.Vpc
  vpcId: pulumi.Output<string>
  vpcPublicSubnetIds: Promise<pulumi.Output<string>[]>
  kubeconfig: pulumi.Output<any>
  clusterName: string
  clusterEndpoint: pulumi.Output<string>
  clusterOidcProviderId: pulumi.Output<string>
  clusterOidcProviderUrl: pulumi.Output<string>
  clusterOidcProviderArn: pulumi.Output<string>
  eksHash: pulumi.Output<string>
  nodeGroupRole: aws.iam.Role
  developerClusterRole: k8s.rbac.v1.ClusterRole

  constructor(name: string, args: ClusterStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:ClusterStack', name, {}, opts)

    const {
      project,
      clusterAdminRole,
      developerRole,
      keyPairName,
      encryptionConfigKeyArn,
    } = args
    const clusterName = `${project}-cluster`

    // IAM role for eks managed node group
    const instanceAssumeRolePolicy = aws.iam.getPolicyDocument({
      statements: [{
        actions: ['sts:AssumeRole'],
        principals: [{
          type: 'Service',
          identifiers: ['ec2.amazonaws.com'],
        }],
      }],
    })
    const nodeGroupRole = new aws.iam.Role(`NgRole-${clusterName}`, {
      assumeRolePolicy: instanceAssumeRolePolicy.then(rolePolicy => rolePolicy.json),
    })
    const policyArns = [
      'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
      'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
      'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
      'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore', // required for Karpenter
    ]
    policyArns.forEach((policyArn, i) => {
      new aws.iam.RolePolicyAttachment(`ng-role-policy-${i}`, { policyArn, role: nodeGroupRole })
    })

    /**
     * VPC
     */
    const vpc = new awsx.ec2.Vpc(`vpc-${clusterName}`, {
      numberOfAvailabilityZones: 2,
      subnets: [
        { type: "public" },
        { type: "private", tags: { [`kubernetes.io/cluster/${clusterName}`]: 'owned' } }, // tags required for Karpenter setup
      ]
    })

    /**
     * EKS cluster
     */
    const cluster = new eks.Cluster(clusterName, {
      name: clusterName,
      skipDefaultNodeGroup: true,
      vpcId: vpc.id,
      publicSubnetIds: vpc.publicSubnetIds,
      privateSubnetIds: vpc.privateSubnetIds,
      // gpu: true,
      createOidcProvider: true, // creates OIDC Provider to enable IAM Roles for Service Accounts (IRSA) in EKS
      instanceRoles: [nodeGroupRole],
      ...encryptionConfigKeyArn ? { encryptionConfigKeyArn } : {},
      roleMappings: [
        // Provides full administrator cluster access to the k8s cluster
        {
          groups: ['system:masters'],
          roleArn: clusterAdminRole.arn,
          username: 'admin-user',
        },
        {
          groups: ['prod-group'],
          roleArn: developerRole.arn,
          username: 'developer-user',
        },
      ],
    }, {})
    const kubeconfig = cluster.kubeconfig
    const clusterOidcProvider = cluster.core.oidcProvider as any
    const clusterEndpoint = cluster.core.endpoint

    /**
     * EKS managed node group
     */
    const defaultNodeGroupName = 'aws-managed-ng-default'
    const defaultNodeGroup = new eks.ManagedNodeGroup(defaultNodeGroupName, {
      cluster: {
        ...cluster.core,
        nodeGroupOptions: {
          ...keyPairName ? { keyName: keyPairName } : {}, // to access EC2 instances in the cluster via ssh
        },  
      },
      capacityType: 'ON_DEMAND',
      instanceTypes: ['t3.medium'],
      nodeGroupName: defaultNodeGroupName,
      nodeRole: nodeGroupRole,
      diskSize: 30,
      scalingConfig: {
        desiredSize: 4,
        minSize: 4,
        maxSize: 20,
      },
    }, { // DO NOT specify k8sProvider here - it'll error out
      dependsOn: [cluster],
      ignoreChanges: ['scalingConfig.desiredSize'], // required for Cluster Autoscaler setup
    })

    /**
     * Create Kubernetes RBAC objects to allow access for mapped IAM roles
     */
    const clusterAdminK8sClusterRoleName = 'ClusterAdminRole'
    const clusterAdminK8sClusterRole = new k8s.rbac.v1.ClusterRole(clusterAdminK8sClusterRoleName, {
      metadata: {
        name: clusterAdminK8sClusterRoleName,
      },
      rules: [{
        apiGroups: ['*'],
        resources: ['*'],
        verbs: ['*'],
      }]
    }, { provider: cluster.provider })

    const clusterAdminK8sClusterRoleBindingName = 'cluster-admin-binding'
    new k8s.rbac.v1.ClusterRoleBinding(clusterAdminK8sClusterRoleBindingName, {
      metadata: {
        name: clusterAdminK8sClusterRoleBindingName,
      },
      subjects: [{
        kind: 'User',
        name: 'admin-user',
      }],
      roleRef: {
        kind: 'ClusterRole',
        name: clusterAdminK8sClusterRole.metadata.name,
        apiGroup: 'rbac.authorization.k8s.io',
      },
    }, { provider: cluster.provider })

    const developerK8sClusterRoleName = 'DeveloperRole'
    const developerK8sClusterRole = new k8s.rbac.v1.ClusterRole(developerK8sClusterRoleName, {
      metadata: {
        name: developerK8sClusterRoleName,
      },
      rules: [{
        apiGroups: ['*'],
        resources: ['*'],
        verbs: ['*'],
      }]
    }, { provider: cluster.provider })

    this.vpc = vpc
    this.vpcId = vpc.id
    this.vpcPublicSubnetIds = vpc.publicSubnetIds
    this.kubeconfig = kubeconfig
    this.clusterName = clusterName
    this.clusterEndpoint = clusterEndpoint
    this.clusterOidcProviderId = clusterOidcProvider.id
    this.clusterOidcProviderUrl = clusterOidcProvider.url
    this.clusterOidcProviderArn = clusterOidcProvider.arn
    this.eksHash = clusterOidcProvider.id.apply((oidcProviderId: string) => oidcProviderId.split('/').slice(-1)[0])
    this.nodeGroupRole = nodeGroupRole
    this.developerClusterRole = developerK8sClusterRole

    this.registerOutputs()
  }
}