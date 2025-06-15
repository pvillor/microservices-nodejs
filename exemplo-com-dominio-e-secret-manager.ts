import { interpolate } from '@pulumi/pulumi';
import * as awsx from '@pulumi/awsx';
import * as aws from '@pulumi/aws';

const zone = aws.route53.getZone({
  name: 'livedocs.dev',
})

const cert = new aws.acm.Certificate("aws-workshop-acm-certificate", {
  domainName: "app.livedocs.dev",
  validationMethod: "DNS",
})

const validationRecord = new aws.route53.Record("aws-workshop-domain-record", {
  zoneId: zone.then(zone => zone.zoneId),
  name: cert.domainValidationOptions[0].resourceRecordName,
  type: cert.domainValidationOptions[0].resourceRecordType,
  records: [cert.domainValidationOptions[0].resourceRecordValue],
  ttl: 60,
})

const validatedCert = new aws.acm.CertificateValidation("aws-workshop-acm-validation", {
  certificateArn: cert.arn,
  validationRecordFqdns: [validationRecord.fqdn],
});

const cluster = new awsx.classic.ecs.Cluster('aws-workshop-cluster')

const lb = new awsx.classic.lb.ApplicationLoadBalancer('aws-workshop-lb', { 
  securityGroups: cluster.securityGroups,
})

new aws.route53.Record("app-alias", {
  zoneId: zone.then(zone => zone.zoneId),
  name: "app",
  type: "A",
  aliases: [{
    name: lb.loadBalancer.dnsName,
    zoneId: lb.loadBalancer.zoneId,
    evaluateTargetHealth: true,
  }],
});

const targetGroup = lb.createTargetGroup('aws-workshop-targets', {
  port: 3333,
  protocol: 'HTTP',
  healthCheck: {
    protocol: 'HTTP',
    path: '/health',
    healthyThreshold: 3,
    unhealthyThreshold: 3,
    timeout: 5,
    interval: 10,
  },
})

const web = lb.createListener('aws-workshop-listener', { 
  port: 443,
  targetGroup,
  protocol: "HTTPS",
  sslPolicy: "ELBSecurityPolicy-2016-08",
  certificateArn: validatedCert.certificateArn,
});

const repo = new awsx.ecr.Repository('aws-workshop-repository', {
  forceDelete: true
})

const image = new awsx.ecr.Image('aws-workshop-image', { 
  repositoryUrl: repo.url, 
  context: '../',
  platform: 'linux/amd64',
})

const executionRole = new aws.iam.Role('aws-workshop-execution-role', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ecs-tasks.amazonaws.com',
  }),
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
  ],
  inlinePolicies: [
    {
      name: "inline",
      policy: aws.iam.getPolicyDocumentOutput({
        statements: [
          {
            sid: "ReadSsmAndSecrets",
            actions: [
              "ssm:GetParameters",
              "ssm:GetParameter",
              "ssm:GetParameterHistory",
            ],
            resources: ["arn:aws:ssm:us-east-1:202533516528:parameter/workshop/dev/*"],
          },
        ],
      }).json,
    },
  ],
})

const appService = new awsx.classic.ecs.FargateService('aws-workshop-app', {
  cluster,
  waitForSteadyState: false,
  taskDefinitionArgs: {
    executionRole,
    container: {
      image: image.imageUri,
      cpu: 256,
      memory: 512,
      portMappings: [web],
      secrets: [
        { name: 'name', valueFrom: '/workshop/dev/NAME' },
      ],
    },
  },
  desiredCount: 1,
})

const scalingTarget = new aws.appautoscaling.Target('aws-workshop-autoscaling-target', {
  minCapacity: 1,
  maxCapacity: 5,
  serviceNamespace: 'ecs',
  scalableDimension: 'ecs:service:DesiredCount',
  resourceId: interpolate`service/${appService.cluster.cluster.name}/${appService.service.name}`,
})

new aws.appautoscaling.Policy(
  'aws-workshop-autoscaling-policy-cpu',
  {
    serviceNamespace: scalingTarget.serviceNamespace,
    scalableDimension: scalingTarget.scalableDimension,
    resourceId: scalingTarget.resourceId,
    policyType: 'TargetTrackingScaling',
    targetTrackingScalingPolicyConfiguration: {
      predefinedMetricSpecification: {
        predefinedMetricType: 'ECSServiceAverageCPUUtilization',
      },
      targetValue: 50,
    },
  },
);

export const url = interpolate`http://${web.endpoint.hostname}`