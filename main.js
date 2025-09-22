const tcpProxy = require('node-tcp-proxy');
const onvifServer = require('./src/onvif-server');
const configBuilder = require('./src/config-builder');
const package = require('./package.json');
const argparse = require('argparse');
const readline = require('readline');
const stream = require('stream');
const yaml = require('yaml');
const fs = require('fs');
const path = require('path');
const simpleLogger = require('simple-node-logger');

const parser = new argparse.ArgumentParser({
    description: 'Virtual Onvif Server'
});

parser.add_argument('-v', '--version', { action: 'store_true', help: 'show the version information' });
parser.add_argument('-cc', '--create-config', { action: 'store_true', help: 'create a new config' });
parser.add_argument('-d', '--debug', { action: 'store_true', help: 'show onvif requests' });
parser.add_argument('config', { help: 'config filename to use', nargs: '?'});

let args = parser.parse_args();

if (args) {
    const logFilePath = path.resolve(process.cwd(), 'log.txt');
    const logger = simpleLogger.createSimpleFileLogger(logFilePath);
    const bindConsoleEcho = (level, emitter) => {
        const original = logger[level].bind(logger);
        logger[level] = (...messages) => {
            original(...messages);
            emitter(...messages);
        };
    };

    bindConsoleEcho('error', (...messages) => console.error(...messages));
    bindConsoleEcho('warn', (...messages) => console.warn(...messages));

    logger.info(`Logging initialized. Writing output to ${logFilePath}`);
    console.log(`Logging initialized. Writing output to ${logFilePath}`);

    if (args.debug)
        logger.setLevel('trace');

    if (args.version) {
        logger.info('Version: ' + package.version);
        console.log('Version: ' + package.version);
        return;
    }

    if (args.create_config) {
        let mutableStdout = new stream.Writable({
            write: function(chunk, encoding, callback) {
                if (!this.muted || chunk.toString().includes('\n'))
                    process.stdout.write(chunk, encoding);
                callback();
            }
        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: mutableStdout,
            terminal: true
        });

        mutableStdout.muted = false;
        rl.question('Onvif Server: ', (hostname) => {
            rl.question('Onvif Username: ', (username) => {
                mutableStdout.muted = true;
                process.stdout.write('Onvif Password: ');
                rl.question('', (password) => {
                    logger.info('Generating config ...');
                    console.log('Generating config ...');
                    const finalize = () => {
                        mutableStdout.muted = false;
                        rl.close();
                    };

                    configBuilder.createConfig(hostname, username, password, logger)
                        .then((config) => {
                            if (config) {
                                logger.info('Config created successfully. Outputting generated configuration.');
                                console.log('# ==================== CONFIG START ====================');
                                console.log(yaml.stringify(config));
                                console.log('# ===================== CONFIG END =====================');
                            } else {
                                logger.error('Config builder returned no configuration object.');
                                console.log('Failed to create config! Check log.txt for details.');
                            }
                            finalize();
                        })
                        .catch((error) => {
                            const message = error && error.message ? error.message : error;
                            logger.error(`Failed to create config: ${message}`);
                            if (error && error.stack)
                                logger.error(error.stack);
                            console.log('Failed to create config! Check log.txt for details.');
                            finalize();
                        });
                });
            });
        });

    } else if (args.config) {
        let configData;
        try {
            configData = fs.readFileSync(args.config, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.error('File not found: ' + args.config);
                return -1;
            }
            throw error;
        }

        let config;
        try {
            config = yaml.parse(configData);
        } catch (error) {
            logger.error('Failed to read config, invalid yaml syntax.')
            return -1;
        }

        let proxies = {};

        for (let onvifConfig of config.onvif) {
            let server = onvifServer.createServer(onvifConfig, logger);
            if (server.getHostname()) {
                logger.info(`Starting virtual onvif server for ${onvifConfig.name} on ${onvifConfig.mac} ${server.getHostname()}:${onvifConfig.ports.server} ...`);
                server.startServer();
                server.startDiscovery();
                if (args.debug)
                    server.enableDebugOutput();
                logger.info('  Started!');
                logger.info('');

                if (!proxies[onvifConfig.target.hostname])
                    proxies[onvifConfig.target.hostname] = {}
                
                if (onvifConfig.ports.rtsp && onvifConfig.target.ports.rtsp)
                    proxies[onvifConfig.target.hostname][onvifConfig.ports.rtsp] = onvifConfig.target.ports.rtsp;
                if (onvifConfig.ports.snapshot && onvifConfig.target.ports.snapshot)
                    proxies[onvifConfig.target.hostname][onvifConfig.ports.snapshot] = onvifConfig.target.ports.snapshot;
            } else {
                logger.error(`Failed to find IP address for MAC address ${onvifConfig.mac}`)
                return -1;
            }
        }
        
        for (let destinationAddress in proxies) {
            for (let sourcePort in proxies[destinationAddress]) {
                logger.info(`Starting tcp proxy from port ${sourcePort} to ${destinationAddress}:${proxies[destinationAddress][sourcePort]} ...`);
                tcpProxy.createProxy(sourcePort, destinationAddress, proxies[destinationAddress][sourcePort]);
                logger.info('  Started!');
                logger.info('');
            }
        }

    } else {
        logger.error('Please specifiy a config filename!');
        return -1;
    }

    return 0;
}
