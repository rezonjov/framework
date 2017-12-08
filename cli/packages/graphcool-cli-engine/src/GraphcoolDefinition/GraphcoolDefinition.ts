import { Config } from '../Config'
import { Output } from '../index'
import { readDefinition } from './yaml'
import { Args, Stages } from '../types/common'
import { GraphcoolDefinition } from 'graphcool-json-schema'
import * as fs from 'fs-extra'
import chalk from 'chalk'
import { Environment } from '../Environment'
import { mapValues } from 'lodash'
import * as yamlParser from 'yaml-ast-parser'
import { StageNotFound } from '../errors/StageNotFound'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as jwt from 'jsonwebtoken'

interface ErrorMessage {
  message: string
}

export class GraphcoolDefinitionClass {
  out: Output
  config: Config
  definition?: GraphcoolDefinition
  typesString?: string
  rawStages: Stages
  secrets: string[] | null
  private definitionString: string
  constructor(out: Output, config: Config) {
    this.out = out
    this.config = config
    this.secrets = null
  }
  async load(env: Environment, args: Args, envPath?: string) {
    if (this.config.definitionPath) {
      dotenv.config({ path: envPath })
      this.definition = await readDefinition(
        this.config.definitionPath,
        this.out,
        args,
      )
      this.definitionString = fs.readFileSync(
        this.config.definitionPath,
        'utf-8',
      )
      this.rawStages = this.definition.stages
      this.definition.stages = this.resolveStageAliases(this.definition.stages)
      this.ensureOfClusters(this.definition, env)
      this.typesString = this.getTypesString(this.definition)
      this.secrets = this.definition.secret
        ? this.definition.secret.replace(/\s/g, '').split(',')
        : null
      if (this.secrets === null && !this.definition.disableAuth) {
        throw new Error(
          'Please either provide a secret in your graphcool.yml or disableAuth: true',
        )
      }
    } else {
      throw new Error(`Please create a graphcool.yml`)
    }
  }

  getToken(serviceName: string, stageName: string): string | undefined {
    if (this.secrets) {
      const data = {
        data: {
          service: `${serviceName}@${stageName}`,
          roles: ['admin'],
        },
      }
      console.log(data, this.secrets[0])
      return jwt.sign(data, this.secrets[0], {
        expiresIn: '1h',
      })
    }

    return undefined
  }

  getStage(name: string, throws: boolean = false): string | undefined {
    const stage =
      this.definition &&
      (this.definition.stages[name] || this.definition.stages.default)
    if (!throws) {
      return stage
    }

    if (!stage) {
      throw new StageNotFound(name)
    }

    return stage
  }

  setStage(name: string, clusterName: string) {
    this.definitionString = this.insertToDefinition(
      this.definitionString,
      'stages',
      `\n  ${name}: ${clusterName}`,
    )
  }

  insertToDefinition(file: string, key: string, insertion: string) {
    const obj = yamlParser.safeLoad(file)

    const mapping = obj.mappings.find(m => m.key.value === key)
    if (mapping) {
      const end = mapping.endPosition

      const newFile = file.slice(0, end) + insertion + file.slice(end)
      const valueStart = mapping.value.startPosition
      const valueEnd = mapping.value.endPosition
      if (mapping.value && valueEnd - valueStart < 4) {
        return newFile.slice(0, valueStart) + newFile.slice(valueEnd)
      }

      return newFile
    } else {
      return file + `\n${key}: ` + insertion
    }
  }

  save() {
    fs.writeFileSync(this.config.definitionPath!, this.definitionString)
  }

  private getTypesString(definition: GraphcoolDefinition) {
    const typesPaths = Array.isArray(definition.datamodel)
      ? definition.datamodel
      : [definition.datamodel]

    const errors: ErrorMessage[] = []
    let allTypes = ''
    typesPaths.forEach(unresolvedTypesPath => {
      const typesPath = path.join(
        this.config.definitionDir,
        unresolvedTypesPath,
      )
      if (fs.existsSync(typesPath)) {
        const types = fs.readFileSync(typesPath, 'utf-8')
        allTypes += types + '\n'
      } else {
        throw new Error(
          `The types definition file "${typesPath}" could not be found.`,
        )
      }
    })

    return allTypes
  }

  private ensureOfClusters(definition: GraphcoolDefinition, env: Environment) {
    Object.keys(definition.stages).forEach(stageName => {
      const referredCluster = definition.stages[stageName]
      if (!env.clusters.find(c => c.name === referredCluster)) {
        throw new Error(
          `Could not find cluster '${
            referredCluster
          }', which is used in stage '${stageName}'.`,
        )
      }
    })
  }

  private resolveStageAliases = stages =>
    mapValues(stages, target => this.resolveStage(target, stages))

  private resolveStage = (
    stage: string,
    stages: { [key: string]: string },
  ): string =>
    stages[stage] ? this.resolveStage(stages[stage], stages) : stage

  get default(): string | null {
    if (
      this.definition &&
      this.definition.stages &&
      this.definition.stages.default
    ) {
      return this.definition.stages.default
    }

    return null
  }
}
