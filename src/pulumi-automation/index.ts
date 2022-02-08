import * as ora from 'ora'
import {
  LocalWorkspace,
  ProjectSettings,
  Stack,
  PulumiFn,
  ConfigMap,
} from '@pulumi/pulumi/automation'
import { PulumiPlugin } from '../pulumi/types'
import { getColor } from '../helpers'
import * as logUpdate from 'log-update'

const cwd = process.cwd()

const infoColor = getColor('info')
const successColor = getColor('success')
const errorColor = getColor('error')
const outputColor = getColor('output')

export type CreatePulumiFn = (inputs: any[]) => PulumiFn

export interface PulumiProgramArgs {
  createPulumiProgram: CreatePulumiFn,
  plugins?: PulumiPlugin[],
  configMap?: ConfigMap,
}

export interface PulumiStackUpOptions {
  inputs?: any[],
  beforeUp?: (opts: PulumiAutomationHookOptions) => any,
  afterUp?: (opts: PulumiAutomationHookOptions) => any,
}

export interface PulumiStackDestroyOptions {
  remove?: boolean,
  beforeDestroy?: (opts: PulumiAutomationHookOptions) => any,
  afterDestroy?: (opts: PulumiAutomationHookOptions) => any,
}

export interface PulumiAutomationOptions {
  globalConfigMap?: ConfigMap,
  beforePulumiRun?: (opts: PulumiAutomationHookOptions) => any,
  afterPulumiRun?: (opts: PulumiAutomationHookOptions) => any,
  debug?: boolean,
}

export interface PulumiAutomationHookOptions {
  [key: string]: any,
}

export class PulumiAutomation {
  project: string
  options: PulumiAutomationOptions

  constructor(project: string, options: PulumiAutomationOptions = {}) {
    this.project = project
    this.options = options
  }

  async stackUp(stackName: string, programArgs: PulumiProgramArgs, options?: PulumiStackUpOptions): Promise<any> {
    const { globalConfigMap = {}, beforePulumiRun, afterPulumiRun, debug = false } = this.options
    const { createPulumiProgram, plugins = [], configMap = {} } = programArgs
    const { inputs = [], beforeUp, afterUp } = options || {}

    const program = createPulumiProgram(inputs)

    beforePulumiRun && beforePulumiRun({ stackName, configMap })

    beforeUp && beforeUp({ stackName })

    const stackOutputs = await pulumiRun({
      projectName: this.project,
      stackName,
      program,
      plugins,
      configMap: { ...configMap, ...globalConfigMap },
      options: { destroy: false, remove: false, debug },
    })

    afterUp && afterUp({ stackName })

    afterPulumiRun && afterPulumiRun({ stackName, configMap })

    return stackOutputs
  }

  async stackDestroy(stackName: string, options?: PulumiStackDestroyOptions): Promise<any> {
    const { beforePulumiRun, afterPulumiRun, debug = false } = this.options
    const { remove = true, beforeDestroy, afterDestroy } = options || {}

    beforePulumiRun && beforePulumiRun({ stackName })

    beforeDestroy && beforeDestroy({ stackName })

    const stackOutputs = await pulumiRun({
      projectName: this.project,
      stackName,
      program: async () => { },
      plugins: [],
      configMap: {},
      options: { destroy: true, remove, debug },
    })

    afterDestroy && afterDestroy({ stackName })

    afterPulumiRun && afterPulumiRun({ stackName, remove })

    return stackOutputs
  }
}

export interface PulumiRunOptions {
  destroy: boolean,
  remove: boolean,
  debug: boolean,
}

export interface PulumiRunArgs {
  projectName: string,
  stackName: string,
  program: PulumiFn,
  plugins?: PulumiPlugin[],
  configMap?: ConfigMap,
  options: PulumiRunOptions,
}

export const pulumiRun = async ({
  projectName,
  stackName,
  program,
  plugins,
  configMap = {},
  options: {
    destroy,
    remove,
    debug,
  },
}: PulumiRunArgs) => {
  try {
    const spinner = ora().start(infoColor(`Initializing '${stackName}' stack...`))
    const projectSettings: ProjectSettings = {
      name: projectName,
      runtime: 'nodejs',
    }
    const ws = await LocalWorkspace.create({
      projectSettings,
      workDir: cwd,
      program,
    })
    const stack = await Stack.createOrSelect(stackName, ws)
    spinner.succeed(successColor(`Stack '${stackName}' initialized`))

    const handleOutput = (out: string) => {
      if (debug) {
        console.info(out)
      } else {
        logUpdate(`\n${out}`)
      }
    }

    if (destroy) {
      // Refresh the stack in case there are manual pre-run commands
      spinner.start(infoColor(`Refreshing '${stackName}' stack...`))
      await stack.refresh({ onOutput: handleOutput })
      if (!debug) { logUpdate.clear() }
      spinner.succeed(successColor(`Refreshed '${stackName}' stack`))

      spinner.start(infoColor(`Destroying '${stackName}' stack...`))
      const destroyRes = await stack.destroy({ onOutput: handleOutput })
      if (!debug) { logUpdate.clear() }
      spinner.succeed(successColor(`Destroyed '${stackName}' stack`))

      if (remove) {
        spinner.start(infoColor(`Removing '${stackName}' stack...`))
        ws.removeStack(stackName)
        spinner.succeed(successColor(`Removed '${stackName}' stack`))
      }

      return destroyRes.summary
    }

    if (Array.isArray(plugins) && plugins.length > 0) {
      spinner.start(infoColor('Installing plugins...'))
      const pluginPromises = plugins.map(({ name, version, kind }) => {
        return stack.workspace.installPlugin(name, version, kind)
      })
      await Promise.all(pluginPromises)
      spinner.succeed(successColor('Plugins installed'))
    }

    // spinner.start(infoColor('Setting up config...'))
    await stack.setAllConfig(configMap)
    // spinner.succeed(successColor('Config set'))

    /**
     * GOTCHA:
     *    This refresh steps makes config setting unreliable.
     *    Keep getting aws:region not available until this is commented out.
     */
    // console.info(infoColor(`Refreshing '${stackName}' stack...`))
    // await stack.refresh({ onOutput: console.info })
    // console.info(successColor('Refresh complete'))

    spinner.start(infoColor(`Updating '${stackName}' stack...`))
    const upRes = await stack.up({ onOutput: handleOutput })
    if (!debug) { logUpdate.clear() }
    spinner.succeed(successColor(`Successfully updated '${stackName}' stack`))
    // console.log(successColor(`\nUpdate summary for '${stackName}' stack: \n${JSON.stringify(upRes.summary.resourceChanges, null, 4)}`))
    // console.log(outputColor(`\nOutputs: \n${JSON.stringify(upRes.outputs, null, 4)}`))
    return upRes.outputs
  } catch (err) {
    console.log(errorColor(err))

    // Add logic to destroy the stack on error?
    // Stack might be updating, then it needs to be cancelled first
    // Cloud op might be hanging - this would require export/import fix to remove pending op
    // Remove the stack altogether?

    process.exit(1)
  }
}