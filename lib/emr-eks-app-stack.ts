import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';

//import {readYamlFromDir} from '../utils/read-file';

import { CfnInstanceProfile, ManagedPolicy, Policy, PolicyDocument, PolicyStatement, Role, ServicePrincipal, Effect } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { InstanceClass, InstanceSize, InstanceType, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AuroraMysqlEngineVersion, ClusterInstance, Credentials, DatabaseCluster, DatabaseClusterEngine } from 'aws-cdk-lib/aws-rds';
import { CapacityType, CfnAddon, Cluster, KubernetesVersion, NodegroupAmiType } from 'aws-cdk-lib/aws-eks';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import * as IamPolicyEbsCsiDriver from './../k8s/iam-policy-ebs-csi-driver.json';
import { KubectlV33Layer } from '@aws-cdk/lambda-layer-kubectl-v33';
import * as eks from 'aws-cdk-lib/aws-eks';


export class EmrEksAppStack extends cdk.Stack {
  
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const clusterAdmin = new Role(this, 'emr-eks-adminRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),

    });
    
    const clusterName = "emr-eks-workshop"

    const kubectl = new KubectlV33Layer(this, 'KubectlLayer');

    clusterAdmin.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
    clusterAdmin.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const emrEksRole = new Role(this, 'EMR_EKS_Job_Execution_Role', {
      assumedBy: new ServicePrincipal('eks.amazonaws.com'),
      roleName: 'EMR_EKS_Job_Execution_Role'
    });

    // Attach this instance role to Cloud9-EC2 instance and disable AWS Temp Credentials on Cloud9
    const emreksInstanceProfile = new CfnInstanceProfile(
      this,
      'InstanceProfile',
      {
        instanceProfileName: 'emr-eks-instance-profile',
        roles: [
          clusterAdmin.roleName,
        ],
      }
    );

    emrEksRole.addToPolicy(new PolicyStatement({
      resources: ['*'],
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:ListBucket', 'glue:AlterPartitions', 'glue:GetUserDefinedFunctions', 'glue:GetDatabase', 'glue:GetDatabases', 'glue:CreateDatabase', 'glue:CreateTable', 'glue:GetTable', 'glue:GetPartition', 'glue:GetPartitions', 'glue:DeletePartition', 'glue:BatchCreatePartition', 'glue:DeleteTable', 'glue:ListSchemas', 'glue:UpdateTable', 'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupEgress', 'ec2:RevokeSecurityGroupIngress', 'ec2:DeleteSecurityGroup', 'acm:DescribeCertificate'],
    }));

    emrEksRole.addToPolicy(new PolicyStatement({
      resources: ['arn:aws:logs:*:*:*'],
      actions: ['logs:PutLogEvents', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:CreateLogGroup'],
    }));

    const vpc = new Vpc(this, "eks-vpc", {
      maxAzs: 3,
      natGateways: 1  // Use 3 AZs but only 1 NAT Gateway to reduce EIP usage
    });
    cdk.Tags.of(vpc).add('for-use-with-amazon-emr-managed-policies', 'true');
    cdk.Tags.of(vpc).add('karpenter.sh/discovery', 'emr-eks-workshop');

    const databaseCredentialsSecret = new Secret(this, 'DBCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'hivemsadmin',
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    const databaseSecurityGroup = new SecurityGroup(this, 'DBSecurityGroup', {
      vpc,
      description: 'security group for rds metastore',
    });

    databaseSecurityGroup.addIngressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.tcp(3306),
      'allow MySQL access from vpc',
    );
    
    const cluster = new DatabaseCluster(this, 'DatabaseV8', {
      engine: DatabaseClusterEngine.auroraMysql({ version: AuroraMysqlEngineVersion.VER_3_10_0 }),
      credentials: Credentials.fromSecret(databaseCredentialsSecret),
      defaultDatabaseName: "hivemetastore",
      writer: ClusterInstance.provisioned('writer', {
        instanceType: InstanceType.of(InstanceClass.BURSTABLE3, InstanceSize.MEDIUM),
      }),
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      vpc,
      securityGroups: [databaseSecurityGroup],
    });
    
    
    const karpenterNodeRole = new Role(this, 'KarpenterNodeRole', {
      roleName: `KarpenterNodeRole-${clusterName}`,
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Create instance profile for Karpenter nodes
    const karpenterInstanceProfile = new CfnInstanceProfile(this, 'KarpenterInstanceProfile', {
      instanceProfileName: 'KarpenterNodeInstanceProfile',
      roles: [karpenterNodeRole.roleName],
    });

    const eksCluster = new Cluster(this, "Cluster", {
      vpc: vpc,
      clusterName: 'emr-eks-workshop',
      mastersRole: clusterAdmin,
      defaultCapacity: 0, // we want to manage capacity ourselves
      version: KubernetesVersion.V1_33,
      kubectlLayer: kubectl,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });
    
    
    //eksAuth.addMastersRole(Role.fromRoleArn(this, 'admin', 'ROLE-ARN'));

    const ondemandNG = eksCluster.addNodegroupCapacity("ondemand-ng", {
      instanceTypes: [
        new InstanceType('m5.xlarge'),
        new InstanceType('m5.2xlarge')],
      minSize: 2,
      maxSize: 12,
      capacityType: CapacityType.ON_DEMAND,
      amiType: NodegroupAmiType.AL2023_X86_64_STANDARD,
    });

    const spotNG = eksCluster.addNodegroupCapacity("spot-ng", {
      instanceTypes: [
        new InstanceType('m5.xlarge'),
        new InstanceType('m5.2xlarge')],
      minSize: 2,
      maxSize: 12,
      capacityType: CapacityType.SPOT,
      amiType: NodegroupAmiType.AL2023_X86_64_STANDARD,
    });

    const s3bucket = new Bucket(this, 'bucket', {
      bucketName: 'emr-eks-workshop-'.concat(cdk.Stack.of(this).account),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Add EKS Fargate profile for EMR workloads
    eksCluster.addFargateProfile('fargate', { selectors: [{ namespace: 'eks-fargate' }] });
    
    
    // Karpenter pre-requisite
    const karpenterControllerPolicy = new ManagedPolicy(this, 'KarpenterControllerPolicy', {
            managedPolicyName: `KarpenterControllerPolicy-${clusterName}`,
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'ssm:GetParameter',
                        'ec2:DescribeImages',
                        'ec2:RunInstances',
                        'ec2:DescribeSubnets',
                        'ec2:DescribeSecurityGroups',
                        'ec2:DescribeLaunchTemplates',
                        'ec2:DescribeInstances',
                        'ec2:DescribeInstanceTypes',
                        'ec2:DescribeInstanceTypeOfferings',
                        'ec2:DescribeAvailabilityZones',
                        'ec2:DeleteLaunchTemplate',
                        'ec2:CreateTags',
                        'ec2:CreateLaunchTemplate',
                        'ec2:CreateFleet',
                        'ec2:DescribeSpotPriceHistory',
                        'pricing:GetProducts',
                    ],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'ec2:TerminateInstances',
                        'ec2:DeleteLaunchTemplate',
                    ],
                    resources: ['*'],
                    conditions: {
                        StringEquals: {
                            [`aws:ResourceTag/karpenter.sh/discovery`]: clusterName,
                        },
                    },
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['iam:PassRole'],
                    resources: [karpenterNodeRole.roleArn],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['eks:DescribeCluster'],
                    resources: [eksCluster.clusterArn],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'iam:GetInstanceProfile',
                        'iam:CreateInstanceProfile',
                        'iam:AddRoleToInstanceProfile',
                        'iam:RemoveRoleFromInstanceProfile',
                        'iam:DeleteInstanceProfile',
                        'iam:TagInstanceProfile'
                    ],
                    resources: [`arn:aws:iam::${this.account}:instance-profile/*`],
                }),
            ],
        });

        // Create Karpenter IAM Role for Pod Identity
    const karpenterPodRole = new Role(this, 'KarpenterPodRole', {
            roleName: `${clusterName}-karpenter`,
            assumedBy: new ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
            managedPolicies: [karpenterControllerPolicy],
        });

        // Add Access Entry for Karpenter Node Role
    new eks.CfnAccessEntry(this, 'KarpenterNodeAccessEntry', {
            clusterName: eksCluster.clusterName,
            principalArn: karpenterNodeRole.roleArn,
            type: 'EC2_LINUX'
        });

        // Install EKS Pod Identity Agent addon
    const podIdentityAddon = new eks.CfnAddon(this, 'EksPodIdentityAgent', {
            clusterName: eksCluster.clusterName,
            addonName: 'eks-pod-identity-agent',
            resolveConflicts: 'OVERWRITE',
        });

        // Ensure Pod Identity Association depends on the addon
    const podIdentityAssociation = new eks.CfnPodIdentityAssociation(this, 'KarpenterPodIdentityAssociation', {
            clusterName: eksCluster.clusterName,
            namespace: "karpenter",
            serviceAccount: 'karpenter',
            roleArn: karpenterPodRole.roleArn,
        });

    podIdentityAssociation.addDependency(podIdentityAddon);

        // Tag subnets for Karpenter discovery
    vpc.privateSubnets.forEach((subnet: any) => {
            cdk.Tags.of(subnet).add(`karpenter.sh/discovery`, clusterName);
        });

    //Add EBS CSI DRIVER Service account

    const ebsCsiDriverIrsa = eksCluster.addServiceAccount('ebsCSIDriverRoleSA', {
      name: 'ebs-csi-controller-sa',
      namespace: 'kube-system',
    });

    const ebsCsiDriverPolicyDocument = PolicyDocument.fromJson(IamPolicyEbsCsiDriver);

    const ebsCsiDriverPolicy = new Policy(
      this,
      'IamPolicyEbsCsiDriverIAMPolicy',
      { document: ebsCsiDriverPolicyDocument },
    );

    ebsCsiDriverPolicy.attachToRole(ebsCsiDriverIrsa.role);

    const ebsCSIDriver = new CfnAddon(this, 'ebsCsiDriver', {
      addonName: 'aws-ebs-csi-driver',
      clusterName: eksCluster.clusterName,
      serviceAccountRoleArn: ebsCsiDriverIrsa.role.roleArn,
      addonVersion: 'v1.47.0-eksbuild.1',
      resolveConflicts: "OVERWRITE"
    });

    ebsCSIDriver.node.addDependency(ebsCsiDriverIrsa);

    /** Steps for EMR Studio */

    /*
     * Setup EMRStudio Security Groups
     */
    const EmrStudioEngineSg = new SecurityGroup(this, 'EmrStudioEngineSg', { vpc: eksCluster.vpc, allowAllOutbound: false });
    EmrStudioEngineSg.addIngressRule(Peer.anyIpv4(), Port.tcp(18888), 'Allow traffic from any resources in the Workspace security group for EMR Studio.');
    const EmrStudioWorkspaceSg = new SecurityGroup(this, 'EmrStudioWorkspaceSg', { vpc: eksCluster.vpc, allowAllOutbound: false });
    EmrStudioWorkspaceSg.addEgressRule(Peer.anyIpv4(), Port.tcp(18888), 'Allow traffic to any resources in the Engine security group for EMR Studio.');
    EmrStudioWorkspaceSg.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow traffic to the internet to link Git repositories to Workspaces.');

    /*
    * Setup EMRStudio Service Role 
    */
    const EmrStudioServiceRole = new Role(this, 'EMRStudioServiceRole', {
      assumedBy: new ServicePrincipal('elasticmapreduce.amazonaws.com')
    });
    const EmrStudioPolicyDocument = PolicyDocument.fromJson(JSON.parse(fs.readFileSync('./k8s/iam-policy-emr-studio-service-role.json', 'utf8')));
    const EmrStudioIAMPolicy = new Policy(this, 'EMRStudioServiceIAMPolicy', { document: EmrStudioPolicyDocument });
    EmrStudioIAMPolicy.attachToRole(EmrStudioServiceRole)

    /*
    * Setup EMRStudio User Role
    */

    const EmrStudioUserRole = new Role(this, 'EMRStudioUserRole', { assumedBy: new ServicePrincipal('elasticmapreduce.amazonaws.com') });
    const EmrStudioUserPolicyJson = fs.readFileSync('./k8s/iam-policy-emr-studio-user-role.json', 'utf8');
    const EmrStudioUserPolicyDocument = PolicyDocument.fromJson(JSON.parse(EmrStudioUserPolicyJson.replace('{{EMRSTUDIO_SERVICE_ROLE}}', EmrStudioServiceRole.roleArn).replace('{{DEFAULT_S3_BUCKET_NAME}}', s3bucket.bucketName).replace('{{ACCOUNT_ID}}', cdk.Stack.of(this).account).replace('{{REGION}}', cdk.Stack.of(this).region)));
    const EmrStudioUserIAMPolicy = new ManagedPolicy(this, 'EMRStudioUserIAMPolicy1', { document: EmrStudioUserPolicyDocument });
    //EmrStudioUserIAMPolicy.attachToRole(EmrStudioUserRole);
    EmrStudioUserRole.addManagedPolicy(EmrStudioUserIAMPolicy);


    cdk.Tags.of(EmrStudioEngineSg).add('for-use-with-amazon-emr-managed-policies', 'true');
    cdk.Tags.of(EmrStudioWorkspaceSg).add('for-use-with-amazon-emr-managed-policies', 'true');

    new cdk.CfnOutput(this, 'EmrStudioUserSessionPolicyArn', {
      value: EmrStudioUserIAMPolicy.managedPolicyArn,
      description: 'EmrStudio user session policy Arn'
    });

    new cdk.CfnOutput(this, 'EmrStudioServiceRoleName', {
      value: EmrStudioServiceRole.roleName,
      description: 'EmrStudio Service Role Name'
    });

    new cdk.CfnOutput(this, 'EmrStudioUserRoleName', {
      value: EmrStudioUserRole.roleName,
      description: 'EmrStudio User Role Name'
    });

    new cdk.CfnOutput(this, 'EKSCluster', {
      value: eksCluster.clusterName,
      description: 'Eks cluster name',
      exportName: "EKSClusterName"
    });

    new cdk.CfnOutput(this, 'EKSClusterVpcId', {
      value: eksCluster.vpc.vpcId,
      description: 'EksCluster VpcId',
      exportName: 'EKSClusterVpcId'
    });

    new cdk.CfnOutput(this, 'EKSClusterAdminArn', {
      value: clusterAdmin.roleArn
    });

    new cdk.CfnOutput(this, 'EMRJobExecutionRoleArn', {
      value: emrEksRole.roleArn
    });

    new cdk.CfnOutput(this, 'GetToken', {
      value: 'aws eks get-token --cluster-name '.concat(eksCluster.clusterName).concat(' | jq -r \'.status.token\'')
    });

    new cdk.CfnOutput(this, 'BootStrapCommand', {
      value: 'sh bootstrap.sh '.concat(eksCluster.clusterName).concat(' ').concat(this.region).concat(' ').concat(clusterAdmin.roleArn)
    });

    new cdk.CfnOutput(this, 'S3Bucket', {
      value: 's3://'.concat(s3bucket.bucketName)
    });

  }
}
