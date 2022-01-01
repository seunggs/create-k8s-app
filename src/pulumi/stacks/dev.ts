import * as fs from 'fs'
import * as path from 'path'
import * as pulumi from '@pulumi/pulumi'
import * as docker from '@pulumi/docker'
import * as awsx from '@pulumi/awsx'
import { getRootEnvs } from '../helpers'

export interface DevStackArgs {
  projectRootPath: string,
  config: pulumi.Config,
  project: string,
  stackEnv: string,
}

export class DevStack extends pulumi.ComponentResource {
  constructor(name: string, args: DevStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:DevStack', name, {}, opts)

    const {
      projectRootPath,
      config,
      project,
      stackEnv,
    } = args

    const rootEnvs = getRootEnvs(projectRootPath, { format: 'string' })
    const frontendDirPath = path.resolve(projectRootPath, 'frontend')
    const containerAppPath = '/app'

    const network = new docker.Network('net')

    // Handle pg
    const pgVolumeName = `${project}-db-data`
    const pgVolume = new docker.Volume(pgVolumeName, { name: pgVolumeName })
    const pgImage = new docker.RemoteImage(`${project}-${stackEnv}-postgres-image`, {
      name: 'postgres:13.3',
      keepLocally: true, // don't delete the image from the local machine when deleting this resource.
    })
    const dbName = config.require('db_name')
    const dbUser = config.require('db_user')
    const dbPassword = config.requireSecret('db_password')
    const dbPort = parseInt(config.require('db_port'))
    const dbHostname = config.require('db_hostname')
    const pgContainer = new docker.Container('postgres-container', {
      image: pgImage.name,
      networksAdvanced: [{ name: network.name }],
      hostname: dbHostname,
      restart: 'always',
      volumes: [{ volumeName: pgVolume.name, containerPath: '/var/lib/postgresql/data' }],
      envs: [
        `DB_NAME=${dbName}`,
        `DB_USER=${dbUser}`,
        pulumi.interpolate`DB_PASSWORD=${dbPassword}`,
      ],
      ports: [{ internal: dbPort, external: dbPort }],
    })

    // Handle api
    const apiImage = awsx.ecr.buildAndPushImage(`${project}-${stackEnv}-api-image`, {
      context: projectRootPath,
      dockerfile: './Dockerfile.dev',
    })
    const apiHostname = 'api'
    const apiPort = config.requireNumber('api_port')
    const apiContainer = new docker.Container('api-container', {
      image: apiImage.imageValue,
      networksAdvanced: [{ name: network.name }],
      hostname: apiHostname,
      restart: 'on-failure',
      volumes: [
        { hostPath: projectRootPath, containerPath: containerAppPath }, // to enable hot-reloading
        { containerPath: `${containerAppPath}/node_modules` },
      ],
      envs: [
        ...rootEnvs,
        pulumi.interpolate`DATABASE_URL=postgresql://${dbUser}:${dbPassword}@${dbHostname}:${dbPort}/${dbName}?schema=public`,
      ],
      ports: [{ internal: apiPort, external: apiPort }]
    }, { dependsOn: [pgContainer] })

    // Generate env file in /prisma with DATABASE_URL - required to run `prisma migrate dev`
    pulumi.interpolate`DATABASE_URL=postgresql://${dbUser}:${dbPassword}@localhost:${dbPort}/${dbName}?schema=public`.apply(databaseUrl => {
      fs.writeFileSync('./prisma/.env', databaseUrl)
    })

    // Handle frontend
    const frontendImage = awsx.ecr.buildAndPushImage(`${project}-${stackEnv}-frontend-image`, {
      context: projectRootPath,
      dockerfile: './frontend/Dockerfile.dev',
    })
    const frontendHostname = 'frontend'
    const frontendPort = config.requireNumber('frontend_port')
    const frontendContainer = new docker.Container('frontend-container', {
      image: frontendImage.imageValue,
      networksAdvanced: [{ name: network.name }],
      hostname: frontendHostname,
      restart: 'on-failure',
      volumes: [
        { hostPath: frontendDirPath, containerPath: containerAppPath }, // to enable hot-reloading
        { containerPath: `${containerAppPath}/node_modules` },
      ],
      envs: [...rootEnvs],
      ports: [{ internal: frontendPort, external: frontendPort }]
    })

    // Handle nginx
    const nginxImage = awsx.ecr.buildAndPushImage(`${project}-${stackEnv}-nginx-image`, {
      context: projectRootPath,
      dockerfile: './nginx/Dockerfile.dev',
    })
    const nginxHostname = 'nginx'
    const nginxPort = config.requireNumber('nginx_port')
    const nginxContainer = new docker.Container('nginx-container', {
      image: nginxImage.imageValue,
      networksAdvanced: [{ name: network.name }],
      hostname: nginxHostname,
      restart: 'on-failure',
      ports: [{ internal: nginxPort, external: nginxPort }]
    })

    this.registerOutputs()
  }
}