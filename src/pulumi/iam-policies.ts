import * as pulumi from '@pulumi/pulumi'

export const getRoute53AddRecordsPolicy = () => {
  return JSON.stringify({
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "route53:GetChange",
        "Resource": "arn:aws:route53:::change/*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets"
        ],
        "Resource": "arn:aws:route53:::hostedzone/*"
      },
      {
        "Effect": "Allow",
        "Action": "route53:ListHostedZonesByName",
        "Resource": "*"
      }
    ]
  })
}

export const getRoleTrustPolicy = ({
  awsRegion,
  awsAccountId,
  eksHash,
  namespace,
  serviceAccountName,
}: {
  awsRegion: string,
  awsAccountId: string,
  eksHash: pulumi.Output<string>,
  namespace: string,
  serviceAccountName: string,
}) => {
  const policyStringified = pulumi.interpolate`{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Principal": {
          "Federated": "arn:aws:iam::${awsAccountId}:oidc-provider/oidc.eks.${awsRegion}.amazonaws.com/id/${eksHash}"
        },
        "Condition": {
          "StringEquals": {
            "oidc.eks.${awsRegion}.amazonaws.com/id/${eksHash}:sub": "system:serviceaccount:${namespace}:${serviceAccountName}"
          }
        }
      }
    ]
  }`
  // policyStringified.apply(t => console.log('policyStringified', t))
  return policyStringified
}

export const getClusterAutoscalerPolicy = () => {
  return JSON.stringify({
    "Version": "2012-10-17",
    "Statement": [
      {
        "Action": [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:DescribeAutoScalingInstances",
          "autoscaling:DescribeLaunchConfigurations",
          "autoscaling:DescribeTags",
          "autoscaling:SetDesiredCapacity",
          "autoscaling:TerminateInstanceInAutoScalingGroup",
          "ec2:DescribeLaunchTemplateVersions"
        ],
        "Resource": "*",
        "Effect": "Allow"
      }
    ]
  })
}