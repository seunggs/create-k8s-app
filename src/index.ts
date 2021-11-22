#!/usr/bin/env node

import * as fs from 'fs-extra'
import * as path from 'path'
import { Command } from 'commander'
import {
  getColor,
  runCliCmd,
  setPulumiConfig,
  getProjectName,
  createPulumiStacks,
} from './pulumi/helpers'
import { PulumiAutomation } from './pulumi/automation/automation'
import { PulumiConfig } from './pulumi/types'
import { simpleStore } from './pulumi/store'

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const infoColor = getColor('info')
const cwd = process.cwd() // dir where the cli is run (i.e. project root)

type CliOptions = {
  [key: string]: any,
}

const program = new Command()

program
  .version('0.0.1', '-v, --version', 'output the version number')

program
  .command('init')
  .requiredOption('--aws-region <aws region>', 'aws region; i.e. us-west-1')
  .requiredOption('--custom-domain <custom domain>', 'your custom domain; i.e. your-domain.com')
  .requiredOption('--custom-domain-zone-id <custom domain zone ID>', 'AWS Route53 Hosted Zone ID for your custom domain; i.e. Z02401234DADFCMEXX64X')
  .requiredOption('--acme-email <ACME email>', 'https certificate issuer (Let\'s Encrypt) will use this to contact you about expiring certificates, and issues related to your account')
  .option('--use-direnv <use direnv>', 'to enable directory specific kubectl setup; defaults to false', false)
  .option('--db-user <DB user>', 'AWS RDS postgres db user name; defaults to admin')
  .option('--db-password <DB user>', 'AWS RDS postgres db password; defaults to adminpass')
  .option('--grafana-user <grafana user name>', 'to enable directory specific kubectl setup; defaults to admin', 'admin')
  .option('--grafana-password <grafana password>', 'to enable directory specific kubectl setup; defaults to adminpass', 'adminpass')
  .description('create a Knative cluster in AWS EKS using Pulumi')
  .showHelpAfterError('(add --help for additional information)')
  .action(handleInit)

// program
//   .command('destroy')
//   .description('destroy the entire project')
//   .showHelpAfterError('(add --help for additional information)')
//   .action(handleDestroy)

program
  .parseAsync()

/**
 * STRATEGY
 * 
 *    Run Pulumi automation scripts to setup Kubernetes and deploy all resources (since as of today, Pulumi CLI cannot be run in a Node script)
 *    Set Pulumi configs via cli - this ensures that configs are stored locally for easier local maintenance (i.e. Pulumi.<stack>.yaml file will be created)
 */
async function handleInit(options: CliOptions) {
  console.log(infoColor('\n\nStarting project build...\n\n'))
  console.log('opions', options)

  // Make options available in other modules
  simpleStore.setState('cliOptions', options)

  const {
    awsRegion,
    customDomain,
    customDomainZoneId,
    acmeEmail,
    dbUser,
    dbPassword,
    useDirenv,
    grafanaUser,
    grafanaPassword,
  } = options

  /**
   * Copy Pulumi files for local management (unless it's development env)
   */
  if (process.env.CKC_CLI_ENV !== 'development') {
    fs.copySync(path.resolve(__dirname, '../src/main.ts'), path.resolve(cwd, 'index.ts'))
    fs.copySync(path.resolve(__dirname, '../src/pulumi'), path.resolve(cwd, 'pulumi'))
  }


  /**
   * Run Pulumi Automation scripts to set up Kubernetes and deploy all resources
   */

  // Set global pulumi configs (these will run for every pulumi stack up)
  simpleStore.setState('globalPulumiConfigs', [
    { key: 'aws:region', configValue: { value: awsRegion } }, // GOTCHA: adding secret field will make this fail
    { key: 'custom_domain', configValue: { value: customDomain } },
  ])

  // First set the cli execution context so that mainPulumiProgram will get the stack name from pulumiStackUp func
  simpleStore.setState('cliExecutionContext', 'ckc')

  // Set pulumi organization
  const pulumiOrganization = process.env.PULUMI_ORGANIZATION || ''
  simpleStore.setState('pulumiOrganization', pulumiOrganization)

  // Must be imported after the cli execution context is set so it has the right context
  const mainPulumiProgram = require('./main')

  // Create stacks for StackReferences first - prevents Pulumi StackReference from erroring out in mainPulumiProgram
  createPulumiStacks(pulumiOrganization, ['cluster', 'db_staging', 'db_prod'])

  const project = getProjectName()
  const globalPulumiConfigs = simpleStore.getState('globalPulumiConfigs')

  const pulumiA = new PulumiAutomation(project, {
    globalConfigs: globalPulumiConfigs,
    beforePulumiRun: (stackName) => {
      // Set the current stack so that mainPulumiProgram will have the right stack
      simpleStore.setState('currentStack', stackName)
    },
    afterPulumiRun: (stackName) => {
      // Set the globalConfigs in cli as well so that Pulumi can be locally managed (i.e. Pulumi.<stack>.yaml file is filled with right configs)
      globalPulumiConfigs.forEach((globalConfig: PulumiConfig) => setPulumiConfig(pulumiOrganization, stackName, globalConfig))
    },
  })

  // Test
  await pulumiA.stackUp('test', { createPulumiProgram: () => mainPulumiProgram })

  // // Provision EKS cluster and setup Cluster Autoscaler for autoscaling nodes based on k8s pod requirements
  // await pulumiA.stackUp('cluster', { createPulumiProgram: () => mainPulumiProgram })

  // // Setup kubectl
  // fs.writeFileSync(path.resolve(cwd, 'kubeconfig-devs.json'), JSON.stringify(clusterOutputs.kubeconfig.value, null, 2))
  // if (useDirenv) {
  //   runCliCmd('echo export KUBECONFIG=$(pwd)/kubeconfig-devs.json > .envrc')
  // } else {
  //   runCliCmd('export KUBECONFIG=$(pwd)/kubeconfig-devs.json')
  // }

  // // Create namespaces for staging/prod apps
  // createAndRunPulumiStack('app_ns')

  // // Install istio operator via cli
  // runCliCmd('istioctlx operator init')

  // // Setup Knative (including Istio)
  // setPulumiConfig('knative_operator', { key: 'knative_serving_version', configValue: { value: '1.0.0' } })
  // createAndRunPulumiStack('knative_operator')

  // createAndRunPulumiStack('knative_serving')
  // createAndRunPulumiStack('knative_eventing')
  // createAndRunPulumiStack('istio')

  // // Setup cert-manager
  // setPulumiConfig('cert_manager', { key: 'custom_domain_zone_id', configValue: { value: customDomainZoneId } })
  // setPulumiConfig('cert_manager', { key: 'acme_email', configValue: { value: acmeEmail } })
  // createAndRunPulumiStack('cert_manager')

  // // Setup custom gateway for Knative so that custom Virtual Services can be used
  // createAndRunPulumiStack('knative_custom_ingress')

  // // Set up Kube Prometheus Stack (end-to-end k8s monitoring using prometheus, grafana, etc)
  // setPulumiConfig('kube_prometheus_stack', { key: 'grafana_user', configValue: { value: grafanaUser } })
  // setPulumiConfig('kube_prometheus_stack', { key: 'grafana_password', configValue: { value: grafanaPassword, secret: true } })
  // createAndRunPulumiStack('kube_prometheus_stack')

  // // Set up staging db and app
  // setPulumiConfig('db_staging', { key: 'db_user', configValue: { value: dbUser } })
  // setPulumiConfig('db_staging', { key: 'db_password', configValue: { value: dbPassword, secret: true } })
  // createAndRunPulumiStack('db_staging')
  // createAndRunPulumiStack('app_staging')

  // // Set up prod db and app
  // setPulumiConfig('db_staging', { key: 'db_user', configValue: { value: dbUser } })
  // setPulumiConfig('db_staging', { key: 'db_password', configValue: { value: dbPassword, secret: true } })
  // createAndRunPulumiStack('db_prod')
  // createAndRunPulumiStack('app_prod')

  // TODO: copy the /pulumi dir to project root (test it without the actual process) for maintenance
}
