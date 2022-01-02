#!/usr/bin/env node

import * as fs from 'fs-extra'
import * as path from 'path'
import * as dotenv from 'dotenv'
import { Command } from 'commander'
import * as ora from 'ora'
import * as enquirer from 'enquirer'
import {
  getColor,
  runCliCmd,
  runCliCmdSync,
  setPulumiConfigsViaCli,
  getProjectName,
} from './pulumi/helpers'
import { PulumiAutomation } from './pulumi-automation'
import { simpleStore } from './pulumi/store'

dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const infoColor = getColor('info')
const successColor = getColor('success')
const gradient = require('gradient-string')
const cwd = process.cwd() // dir where the cli is run (i.e. project root)

const copyPulumiFiles = async () => {
  await fs.copy(path.resolve(__dirname, '../src/main.ts'), path.resolve(cwd, 'index.ts'))
  await fs.copy(path.resolve(__dirname, '../src/pulumi'), path.resolve(cwd, 'pulumi'))
}

type CliOptions = {
  [key: string]: any,
}

const program = new Command()

program
  .version('0.0.1', '-v, --version', 'output the version number')

program
  .command('init')
  // .requiredOption('--aws-region <aws region>', 'aws region; i.e. us-west-1')
  // .requiredOption('--pulumi-organization <Pulumi account/organization>', 'name of your Pulumi account (if free plan) or organization (if paid plan)')
  // .requiredOption('--custom-domain <custom domain>', 'your custom domain; i.e. your-domain.com')
  // .requiredOption('--custom-domain-zone-id <custom domain zone ID>', 'AWS Route53 Hosted Zone ID for your custom domain; i.e. Z02401234DADFCMEXX64X')
  // .requiredOption('--acme-email <ACME email>', 'https certificate issuer (Let\'s Encrypt) will use this to contact you about expiring certificates, and issues related to your account')
  // .option('--encryption-config-key-arn', 'AWS KMS Key ARN to use with the encryption configuration for the cluster')
  // .option('--use-direnv', 'to enable directory specific kubectl setup; defaults to false', false)
  // .option('--grafana-user <grafana user name>', 'to enable directory specific kubectl setup; defaults to ckaadmin', 'ckaadmin')
  // .option('--grafana-password <grafana password>', 'to enable directory specific kubectl setup; defaults to ckaadminpass', 'ckaadminpass')
  .option('--debug', 'show logs', false)
  .description('create a Kubernetes cluster in AWS EKS using Pulumi')
  .showHelpAfterError('(add --help for additional information)')
  .action(handleInit)

/**
 * STRATEGY
 * 
 *    Run Pulumi automation scripts to setup Kubernetes and deploy all resources (since as of today, Pulumi CLI cannot be run in a Node script)
 * 
 *    Separate out infra and app setups - i.e. 2 different cli cmds
 *    TODO: Consider making them separate Pulumi projects
 * 
 *    Pulumi configs: Set Pulumi configs both via Automation API arg and via cli - this ensures that configs are set correctly for cka cli 
 *    execution but also stored locally for local Pulumi management (i.e. Pulumi.<stack>.yaml file will be created)
 */
async function handleInit(cliOptions: CliOptions) {
  console.info(infoColor('\nInitializing project...\n'))
  console.time('Done in')

  let { init: configOptions } = await import(`${cwd}/cka-config.json`)

  if (!configOptions) {
    throw new Error('Must provide "cka-config.json" in your project root folder')
  }

  const {
    awsRegion,
    pulumiOrganization,
    hostname,
    acmeEmail,
    useDirenv = false,
    encryptionConfigKeyArn,
    grafanaUser = 'ckaadmin',
    grafanaPassword = 'ckaadminpass',
  } = configOptions

  const { debug } = cliOptions

  // Make options available in other modules
  simpleStore.setState('cliOptions', cliOptions)

  console.info(`debug=${debug}\n`)

  /**
   * Copy Pulumi files for local management (unless it's development env)
   */
  const spinner = ora().start(infoColor(`Copying Pulumi files to project folder...`))

  if (process.env.CKA_CLI_ENV !== 'development') {
    copyPulumiFiles()
  }

  spinner.succeed(successColor('Successfully copied Pulumi files to project folder'))

  /**
   * Run Pulumi Automation scripts to set up Kubernetes and deploy all resources
   */
  spinner.start(infoColor(`Prepping for Pulumi stack creations...`))

  // Set global pulumi configs (these will run for every pulumi stack up)
  simpleStore.setState('globalPulumiConfigMap', {
    'aws:region': { value: awsRegion },
    'pulumi_organization': { value: pulumiOrganization },
    'hostname': { value: hostname },
  })

  // First set the cli execution context so that mainPulumiProgram will get the stack name from pulumiStackUp func
  simpleStore.setState('cliExecutionContext', 'cka')

  // Must be imported after the cli execution context and other required states are set
  const mainPulumiProgram = await import('./main')

  const projectName = getProjectName()
  const globalPulumiConfigMap = simpleStore.getState('globalPulumiConfigMap')
  const pulumiA = new PulumiAutomation(projectName, {
    debug,
    globalConfigMap: globalPulumiConfigMap,
    beforePulumiRun: ({ stackName }) => {
      // Set the current stack so that mainPulumiProgram will have the right stack
      simpleStore.setState('currentStack', stackName)
    },
    afterPulumiRun: async ({ stackName, configMap }) => {
      // Set the globalConfigs and configs in cli as well so that Pulumi can be locally managed (i.e. Pulumi.<stack>.yaml file is filled with right configs)
      await setPulumiConfigsViaCli(pulumiOrganization, stackName, { ...globalPulumiConfigMap, ...configMap })
    },
  })
  spinner.succeed(successColor('Successfully completed prep'))

  /**
   * Create stacks
   * 
   *    NOTE: order matters
   */

  // Set up some IAM roles to use to access the cluster later
  const identityOutputs = await pulumiA.stackUp(`${pulumiOrganization}/identity`, { createPulumiProgram: () => mainPulumiProgram })

  // Provision EKS cluster with managed node groups
  const clusterStackConfigMap = {
    ...encryptionConfigKeyArn ? { 'encryptionConfigKeyArn': { value: encryptionConfigKeyArn } } : {},
  }
  const clusterOutputs = await pulumiA.stackUp(`${pulumiOrganization}/cluster`, { createPulumiProgram: () => mainPulumiProgram, configMap: clusterStackConfigMap })

  // Set up Karpenter for autoscaling nodes based on k8s pod requirements
  await pulumiA.stackUp(`${pulumiOrganization}/karpenter`, { createPulumiProgram: () => mainPulumiProgram })

  // Set up kubectl
  spinner.start(infoColor(`Exporting kubeconfig for kubectl...`))
  await fs.writeFile(path.resolve(cwd, 'kubeconfig-devs.json'), JSON.stringify(clusterOutputs.kubeconfig.value, null, 2))
  if (useDirenv) {
    runCliCmdSync(`direnv allow .`)
    await runCliCmd('echo export KUBECONFIG=$(pwd)/kubeconfig-devs.json > .envrc')
  } else {
    await runCliCmd('export KUBECONFIG=$(pwd)/kubeconfig-devs.json')
  }
  spinner.succeed(successColor(`Successfully exported kubeconfig for kubectl`))

  // Setup cert-manager
  await pulumiA.stackUp(`${pulumiOrganization}/cert-manager`, { createPulumiProgram: () => mainPulumiProgram })

  // Set up Emissary
  await pulumiA.stackUp(`${pulumiOrganization}/emissary`, { createPulumiProgram: () => mainPulumiProgram })

  // Set up TLS
  const tlsStackConfigMap = {
    'hostname': { value: hostname },
    'acme_email': { value: acmeEmail },
  }
  await pulumiA.stackUp(`${pulumiOrganization}/tls`, { createPulumiProgram: () => mainPulumiProgram, configMap: tlsStackConfigMap })

  // Set up Dapr
  await pulumiA.stackUp(`${pulumiOrganization}/dapr`, { createPulumiProgram: () => mainPulumiProgram })

  // Set up Kube Prometheus Stack (end-to-end k8s monitoring using prometheus, grafana, etc)
  const kubePrometheusStackConfigMap = {
    'hostname': { value: hostname },
    'grafana_user': { value: grafanaUser },
    'grafana_password': { value: grafanaPassword, secret: true },
  }
  await pulumiA.stackUp(`${pulumiOrganization}/kube-prometheus-stack`, { createPulumiProgram: () => mainPulumiProgram, configMap: kubePrometheusStackConfigMap })

  console.info(gradient.pastel(`\n🎉 Successfully created '${projectName}' project\n`))
  console.timeEnd('Done in')
  process.exit(0)
}


program
  .command('app')
  .option('--debug', 'show logs', false)
  .description('create app')
  .showHelpAfterError('(add --help for additional information)')
  .action(handleApp)

async function handleApp(cliOptions: CliOptions) {
  console.info(infoColor('\nCreating app...\n'))
  console.time('Done in')

  let { init: configOptions } = await import(`${cwd}/cka-config.json`)

  if (!configOptions) {
    throw new Error('Must provide "cka-config.json" in your project root folder')
  }

  const {
    awsRegion,
    pulumiOrganization,
    hostname,
    stagingDbUser = 'ckaadmin',
    stagingDbPassword = 'ckaadminpass',
    prodDbUser = 'ckaadmin',
    prodDbPassword = 'ckaadminpass',
  } = configOptions

  const { debug } = cliOptions

  // Make options available in other modules
  simpleStore.setState('cliOptions', cliOptions)

  console.info(`debug=${debug}\n`)

  /**
   * Run Pulumi Automation scripts to set up Kubernetes and deploy all resources
   */
  const spinner = ora().start(infoColor(`Prepping for Pulumi stack creations...`))

  // Set global pulumi configs (these will run for every pulumi stack up)
  simpleStore.setState('globalPulumiConfigMap', {
    'aws:region': { value: awsRegion },
    'pulumi_organization': { value: pulumiOrganization },
  })

  // First set the cli execution context so that mainPulumiProgram will get the stack name from pulumiStackUp func
  simpleStore.setState('cliExecutionContext', 'cka')

  // Must be imported after the cli execution context and other required states are set
  const mainPulumiProgram = await import('./main')

  const projectName = getProjectName()
  const globalPulumiConfigMap = simpleStore.getState('globalPulumiConfigMap')
  const pulumiA = new PulumiAutomation(projectName, {
    debug,
    globalConfigMap: globalPulumiConfigMap,
    beforePulumiRun: ({ stackName }) => {
      // Set the current stack so that mainPulumiProgram will have the right stack
      simpleStore.setState('currentStack', stackName)
    },
    afterPulumiRun: async ({ stackName, configMap }) => {
      // Set the globalConfigs and configs in cli as well so that Pulumi can be locally managed (i.e. Pulumi.<stack>.yaml file is filled with right configs)
      await setPulumiConfigsViaCli(pulumiOrganization, stackName, { ...globalPulumiConfigMap, ...configMap })
    },
  })
  spinner.succeed(successColor('Successfully completed prep'))

  /**
   * Create stacks
   * 
   *    NOTE: order matters
   */
  
  // Set up staging app
  await pulumiA.stackUp(`${pulumiOrganization}/app-staging-init`, { createPulumiProgram: () => mainPulumiProgram })
  await pulumiA.stackUp(`${pulumiOrganization}/app-staging`, { createPulumiProgram: () => mainPulumiProgram })
  
  // Set up staging app ingress
  const appStagingIngressStackConfigMap = {
    'hostname': { value: hostname },
  }
  await pulumiA.stackUp(`${pulumiOrganization}/app-staging-ingress`, { createPulumiProgram: () => mainPulumiProgram, configMap: appStagingIngressStackConfigMap })

  // // Set up prod app
  // await pulumiA.stackUp(`${pulumiOrganization}/app-prod-init`, { createPulumiProgram: () => mainPulumiProgram })
  // await pulumiA.stackUp(`${pulumiOrganization}/app-prod`, { createPulumiProgram: () => mainPulumiProgram })
  // await pulumiA.stackUp(`${pulumiOrganization}/app-prod-ingress`, { createPulumiProgram: () => mainPulumiProgram })

  console.info(gradient.pastel(`\n🦄 Successfully created app!!!\n`))
  console.timeEnd('Done in')
  process.exit(0)
}


program
  .command('copy-pulumi-files')
  .description('copy Pulumi files for local management')
  .showHelpAfterError('(add --help for additional information)')
  .action(handleCopyPulumiFiles)

async function handleCopyPulumiFiles(options: CliOptions) {
  if (process.env.CKA_CLI_ENV !== 'development') {
    console.info(infoColor('\nCopying Pulumi files to project root folder for local management...\n'))
    copyPulumiFiles()
  }
}

program
  .command('destroy')
  .option('--keep-cluster', 'don\'t remove the kubernetes cluster', false)
  .option('--debug', 'show logs', false)
  .description('destroy the entire project')
  .showHelpAfterError('(add --help for additional information)')
  .action(handleDestroy)

async function handleDestroy(cliOptions: CliOptions) {
  console.info(infoColor('\nDestroying project...\n'))
  console.time('Done in')

  let { destroy: configOptions } = await import(`${cwd}/cka-config.json`)

  if (!configOptions) {
    throw new Error('Must provide "cka-config.json" in your project root folder')
  }

  const { removeStacks = true } = configOptions
  const { keepCluster, debug } = cliOptions
  console.log('keepCluster', keepCluster)

  // Make options available in other modules
  simpleStore.setState('cliOptions', cliOptions)

  console.info(`debug=${debug}\n`)

  const projectName = getProjectName()
  const pulumiA = new PulumiAutomation(projectName, {
    debug,
    afterPulumiRun: async ({ stackName, remove }) => {
      if (remove) {
        try {
          // Remove Pulumi.<stack>.yaml from local setup if the stack is removed
          await fs.unlink(path.resolve(cwd, `Pulumi.${stackName}.yaml`))
        } catch (err) {
          const error = err as any
          // Handle file not found error in case destroy fails in the middle and need to be run again
          if (error.code === 'ENOENT') {
            return
          } else {
            throw new Error(error)
          }
        }
      }
    },
  })

  /**
   * Destroy stacks
   * 
   *    NOTE: Destroy them in reverse order - required because there are dependencies
   */

  // Destroy prod app and db
  await pulumiA.stackDestroy('app-prod-ingress', { remove: removeStacks })
  await pulumiA.stackDestroy('app-prod', { remove: removeStacks })
  await pulumiA.stackDestroy('app-prod-init', { remove: removeStacks })
  await pulumiA.stackDestroy('db-prod', { remove: removeStacks })

  // Destroy staging app and db
  await pulumiA.stackDestroy('app-staging-ingress', { remove: removeStacks })
  await pulumiA.stackDestroy('app-staging', { remove: removeStacks })
  await pulumiA.stackDestroy('app-staging-init', { remove: removeStacks })
  await pulumiA.stackDestroy('db-staging', { remove: removeStacks })

  // Destroy monitoring
  await pulumiA.stackDestroy('kube-prometheus-stack', { remove: removeStacks })

  // Destroy Dapr
  await pulumiA.stackDestroy('dapr', { remove: removeStacks })

  // Destroy TLS
  await pulumiA.stackDestroy('tls', { remove: removeStacks })

  // Destroy Emissary
  await pulumiA.stackDestroy('emissary', { remove: removeStacks })

  // Destroy cert-manager
  await pulumiA.stackDestroy('cert-manager', { remove: removeStacks })

  if (!keepCluster) {
    await pulumiA.stackDestroy('karpenter', { remove: removeStacks })
    await pulumiA.stackDestroy('cluster', { remove: removeStacks })
    await pulumiA.stackDestroy('identity', { remove: removeStacks })
  }

  console.info(gradient.fruit(`\n💥 Successfully destroyed '${projectName}' project\n`))
  console.timeEnd('Done in')
  process.exit(0)
}

program
  .parseAsync()
