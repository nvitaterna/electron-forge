/* eslint "no-console": "off" */
import { asyncOra } from '@electron-forge/async-ora';
import PluginBase from '@electron-forge/plugin-base';
import { ElectronProcess, ForgeConfig } from '@electron-forge/shared-types';
import Logger, { Tab } from '@electron-forge/web-multi-logger';
import debug from 'debug';
import fs from 'fs-extra';
import path from 'path';
import webpack, { Configuration } from 'webpack';
import webpackHotMiddleware from 'webpack-hot-middleware';
import webpackDevMiddleware from 'webpack-dev-middleware';
import express from 'express';
import http from 'http';

import once from './util/once';
import { WebpackPluginConfig } from './Config';
import WebpackConfigGenerator from './WebpackConfig';

const d = debug('electron-forge:plugin:webpack');
const DEFAULT_PORT = 3000;
const DEFAULT_LOGGER_PORT = 9000;

export default class WebpackPlugin extends PluginBase<WebpackPluginConfig> {
  name = 'webpack';

  private isProd = false;

  private projectDir!: string;

  private baseDir!: string;

  private _configGenerator!: WebpackConfigGenerator;

  private watchers: webpack.Compiler.Watching[] = [];

  private servers: http.Server[] = [];

  private loggers: Logger[] = [];

  private port = DEFAULT_PORT;

  private loggerPort = DEFAULT_LOGGER_PORT;

  constructor(c: WebpackPluginConfig) {
    super(c);

    if (c.port) {
      if (this.isValidPort(c.port)) {
        this.port = c.port;
      }
    }
    if (c.loggerPort) {
      if (this.isValidPort(c.loggerPort)) {
        this.loggerPort = c.loggerPort;
      }
    }

    this.startLogic = this.startLogic.bind(this);
    this.getHook = this.getHook.bind(this);
  }

  private isValidPort = (port: number) => {
    if (port < 1024) {
      throw new Error(`Cannot specify port (${port}) below 1024, as they are privileged`);
    } else if (port > 65535) {
      throw new Error(`Port specified (${port}) is not a valid TCP port.`);
    } else {
      return true;
    }
  }

  private exitHandler = (options: { cleanup?: boolean; exit?: boolean }, err?: Error) => {
    d('handling process exit with:', options);
    if (options.cleanup) {
      for (const watcher of this.watchers) {
        d('cleaning webpack watcher');
        watcher.close(() => {});
      }
      this.watchers = [];
      for (const server of this.servers) {
        d('cleaning http server');
        server.close();
      }
      this.servers = [];
      for (const logger of this.loggers) {
        d('stopping logger');
        logger.stop();
      }
      this.loggers = [];
    }
    if (err) console.error(err.stack);
    if (options.exit) process.exit();
  }

  async writeJSONStats(
    type: string,
    stats: webpack.Stats,
    statsOptions?: webpack.Stats.ToStringOptions,
  ): Promise<void> {
    d(`Writing JSON stats for ${type} config`);
    const jsonStats = stats.toJson(statsOptions as webpack.Stats.ToJsonOptions);
    const jsonStatsFilename = path.resolve(this.baseDir, type, 'stats.json');
    await fs.writeJson(jsonStatsFilename, jsonStats, { spaces: 2 });
  }

  // eslint-disable-next-line max-len
  private runWebpack = async (options: Configuration, isRenderer = false): Promise<webpack.Stats> => new Promise((resolve, reject) => {
    webpack(options)
      .run(async (err, stats) => {
        if (isRenderer && this.config.renderer.jsonStats) {
          await this.writeJSONStats('renderer', stats, options.stats);
        }
        if (err) {
          return reject(err);
        }
        return resolve(stats);
      });
  });

  init = (dir: string) => {
    this.setDirectories(dir);

    d('hooking process events');
    process.on('exit', (_code) => this.exitHandler({ cleanup: true }));
    process.on('SIGINT' as NodeJS.Signals, (_signal) => this.exitHandler({ exit: true }));
  }

  setDirectories = (dir: string) => {
    this.projectDir = dir;
    this.baseDir = path.resolve(dir, '.webpack');
  }

  get configGenerator() {
    // eslint-disable-next-line no-underscore-dangle
    if (!this._configGenerator) {
    // eslint-disable-next-line no-underscore-dangle
      this._configGenerator = new WebpackConfigGenerator(
        this.config,
        this.projectDir,
        this.isProd,
        this.port,
      );
    }

    // eslint-disable-next-line no-underscore-dangle
    return this._configGenerator;
  }

  private loggedOutputUrl = false;

  getHook(name: string) {
    switch (name) {
      case 'prePackage':
        this.isProd = true;
        return async () => {
          await fs.remove(this.baseDir);
          await this.compileMain();
          await this.compileRenderers();
        };
      case 'postStart':
        return async (_: any, child: ElectronProcess) => {
          if (!this.loggedOutputUrl) {
            console.info(`\n\nWebpack Output Available: ${(`http://localhost:${this.loggerPort}`).cyan}\n`);
            this.loggedOutputUrl = true;
          }
          d('hooking electron process exit');
          child.on('exit', () => {
            if (child.restarted) return;
            this.exitHandler({ cleanup: true, exit: true });
          });
        };
      case 'resolveForgeConfig':
        return this.resolveForgeConfig;
      case 'packageAfterCopy':
        return this.packageAfterCopy;
      default:
        return null;
    }
  }

  resolveForgeConfig = async (forgeConfig: ForgeConfig) => {
    if (!forgeConfig.packagerConfig) {
      forgeConfig.packagerConfig = {};
    }
    if (forgeConfig.packagerConfig.ignore) {
      console.error(`You have set packagerConfig.ignore, the Electron Forge webpack plugin normally sets this automatically.

Your packaged app may be larger than expected if you dont ignore everything other than the '.webpack' folder`.red);
      return forgeConfig;
    }
    forgeConfig.packagerConfig.ignore = (file: string) => {
      if (!file) return false;

      if (this.config.jsonStats && file.endsWith(path.join('.webpack', 'main', 'stats.json'))) {
        return true;
      }

      if (this.config.renderer.jsonStats && file.endsWith(path.join('.webpack', 'renderer', 'stats.json'))) {
        return true;
      }

      return !/^[/\\]\.webpack($|[/\\]).*$/.test(file);
    };
    return forgeConfig;
  }

  packageAfterCopy = async (_: any, buildPath: string) => {
    const pj = await fs.readJson(path.resolve(this.projectDir, 'package.json'));
    if (pj.config) {
      delete pj.config.forge;
    }
    pj.devDependencies = {};
    pj.dependencies = {};
    pj.optionalDependencies = {};
    pj.peerDependencies = {};

    await fs.writeJson(
      path.resolve(buildPath, 'package.json'),
      pj,
      {
        spaces: 2,
      },
    );

    await fs.mkdirp(path.resolve(buildPath, 'node_modules'));
  }

  compileMain = async (watch = false, logger?: Logger) => {
    let tab: Tab;
    if (logger) {
      tab = logger.createTab('Main Process');
    }
    await asyncOra('Compiling Main Process Code', async () => {
      const mainConfig = await this.configGenerator.getMainConfig();
      await new Promise((resolve, reject) => {
        const compiler = webpack(mainConfig);
        const [onceResolve, onceReject] = once(resolve, reject);
        const cb: webpack.ICompiler.Handler = async (err, stats: webpack.Stats) => {
          if (tab && stats) {
            tab.log(stats.toString({
              colors: true,
            }));
          }
          if (this.config.jsonStats) {
            await this.writeJSONStats('main', stats, mainConfig.stats);
          }

          if (err) return onceReject(err);
          if (!watch && stats.hasErrors()) {
            return onceReject(new Error(`Compilation errors in the main process: ${stats.toString()}`));
          }

          return onceResolve();
        };
        if (watch) {
          this.watchers.push(compiler.watch({}, cb));
        } else {
          compiler.run(cb);
        }
      });
    });
  }

  compileRenderers = async (watch = false) => { // eslint-disable-line @typescript-eslint/no-unused-vars, max-len
    await asyncOra('Compiling Renderer Template', async () => {
      const stats = await this.runWebpack(
        await this.configGenerator.getRendererConfig(this.config.renderer.entryPoints),
        true,
      );
      if (!watch && stats.hasErrors()) {
        throw new Error(`Compilation errors in the renderer: ${stats.toString()}`);
      }
    });

    for (const entryPoint of this.config.renderer.entryPoints) {
      if (entryPoint.preload) {
        await asyncOra(`Compiling Renderer Preload: ${entryPoint.name}`, async () => {
          await this.runWebpack(
            await this.configGenerator.getPreloadRendererConfig(entryPoint, entryPoint.preload!),
          );
        });
      }
    }
  }

  launchDevServers = async (logger: Logger) => {
    await asyncOra('Launch Dev Servers', async () => {
      const tab = logger.createTab('Renderers');

      const config = await this.configGenerator.getRendererConfig(this.config.renderer.entryPoints);
      const compiler = webpack(config);
      const server = webpackDevMiddleware(compiler, {
        logger: {
          debug: tab.log.bind(tab),
          log: tab.log.bind(tab),
          info: tab.log.bind(tab),
          error: tab.log.bind(tab),
          warn: tab.log.bind(tab),
        },
        publicPath: '/',
        hot: true,
        historyApiFallback: true,
        writeToDisk: true,
        reload: true,
      } as any);
      const app = express();
      app.use(server);
      app.use(webpackHotMiddleware(compiler));
      this.servers.push(app.listen(this.port));
    });

    await asyncOra('Compiling Preload Scripts', async () => {
      for (const entryPoint of this.config.renderer.entryPoints) {
        if (entryPoint.preload) {
          const config = await this.configGenerator.getPreloadRendererConfig(
            entryPoint,
            entryPoint.preload!,
          );
          await new Promise((resolve, reject) => {
            const tab = logger.createTab(`${entryPoint.name} - Preload`);
            const [onceResolve, onceReject] = once(resolve, reject);

            this.watchers.push(webpack(config).watch({}, (err, stats) => {
              if (stats) {
                tab.log(stats.toString({
                  colors: true,
                }));
              }

              if (err) return onceReject(err);
              return onceResolve();
            }));
          });
        }
      }
    });
  }

  private alreadyStarted = false;

  async startLogic(): Promise<false> {
    if (this.alreadyStarted) return false;
    this.alreadyStarted = true;

    await fs.remove(this.baseDir);

    const logger = new Logger(this.loggerPort);
    this.loggers.push(logger);
    await this.compileMain(true, logger);
    await this.launchDevServers(logger);
    await logger.start();
    return false;
  }
}
