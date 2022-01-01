import * as fs from 'fs'
import * as path from 'path'
import * as pulumi from '@pulumi/pulumi'
import { exec, execSync } from 'child_process'
import * as chalk from 'chalk'
import { ConfigMap } from '@pulumi/pulumi/automation'
import * as yaml from 'js-yaml'

const cwd = process.cwd() // dir where the cli is run

/**
 * Options:
 *    format: one of 'string' or 'object'
 *    exclude: env variable keys to exclude
 */
export const getRootEnvs = (projectRootPath: string, { format = 'object', exclude = [] } = {}) => {
  const dotenv = require('dotenv')
  const envsObj = dotenv.parse(fs.readFileSync(path.resolve(projectRootPath, '.env')))
  const envExclusions = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', ...exclude]
  const envKeys = Object.keys(envsObj)
  const envsArr = envKeys
    .reduce((prev, curr) => [...prev, { name: curr, value: envsObj[curr] }], [] as any[])
    .filter(({ name }) => !envExclusions.includes(name))

  if (format === 'object') {
    // i.e. { name: 'NODE_ENV', value: 'production' }
    return envsArr
  } else if (format === 'string') {
    // i.e. NODE_ENV=production
    return envsArr.map(({ name, value }) => `${name}=${value}`)
  } else {
    return []
  }
}

export const kebabCaseToCamelCase = (kebabStr: string) => {
  return kebabStr.split('-').map((w, i) => {
    if (i == 0) { return w.toLowerCase() }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  }).join('')
}

export const objToContainerEnvs = (obj: { [key: string]: string }) => {
  const keys = Object.keys(obj)
  return keys.reduce((prev: any, curr: any) => ([...prev, { name: curr, value: obj[curr] }]), [])
}

export const getProjectName = () => {
  const pulumiYamlFile = path.resolve(cwd, 'Pulumi.yaml')

  if (!fs.existsSync(pulumiYamlFile)) {
    console.log('error: Pulumi project file "Pulumi.yaml" is not found in project root. You must first create a Pulumi project.')
    process.exitCode = 1
  } else {
    const pulumiYaml: any = yaml.load(fs.readFileSync(pulumiYamlFile, 'utf8'))
    const projectName = pulumiYaml.name
    return projectName
  }
}

interface ColorMap {
  [key: string]: chalk.Chalk
}

export const getColor = (color: string) => {
  const themes: ColorMap = {
    info: chalk.blueBright,
    success: chalk.green,
    output: chalk.rgb(194, 195, 255),
    error: chalk.red,
    warning: chalk.keyword('orange'),
    final: chalk.bold.cyan,
  }
  return themes[color]
}

export const runCliCmd = async (cmd: string) => {
  const stdout = await exec(cmd)
  return stdout
}

export const runCliCmdSync = (cmd: string) => {
  const stdout = execSync(cmd)
  return stdout
}

export const createPulumiStackViaCli = (orgName: string, stackName: string) => {
  const prefixedStackName = `${orgName}/${stackName}`
  try {
    runCliCmdSync(`pulumi stack init ${prefixedStackName}`)
  } catch (err) {
    const errorMessage = (err as Error).toString()
    if (errorMessage.includes('already exists')) {
      return
    } else {
      throw new Error(errorMessage)
    }
  }
}

export const createPulumiStacksViaCli = (orgName: string, stackNames: string[]) => {
  stackNames.forEach(stackName => createPulumiStackViaCli(orgName, stackName))
}

export const runPulumiStackCmd = (orgName: string, stackName: string, cmd: string) => {
  const prefixedStackName = `${orgName}/${stackName}`
  runCliCmdSync(`pulumi stack select ${prefixedStackName} && ${cmd}`)
}

export const setPulumiConfigsViaCli = (orgName: string, stackName: string, configMap: ConfigMap) => {
  const configMapKeys = Object.keys(configMap)
  configMapKeys.forEach(configMapKey => {
    const configMapVal = configMap[configMapKey]
    const { value, secret } = configMapVal
    runPulumiStackCmd(orgName, stackName, `pulumi config set ${configMapKey} ${value}${secret ? ' --secret' : ''}`)
  })
}