const soap = require('soap');
const uuid = require('node-uuid');

function extractPath(url) {
    return url.substr(url.indexOf('/', url.indexOf('//') + 2));
}

async function createConfig(hostname, username, password) {
    let options = {
        forceSoap12Headers: true
    };

    let securityOptions = {
        hasNonce: true,
        passwordType: 'PasswordDigest'
    };
    
    let client = await soap.createClientAsync('./wsdl/media_service.wsdl', options);
    client.setEndpoint(`http://${hostname}/onvif/device_service`);
    client.setSecurity(new soap.WSSecurity(username, password, securityOptions));

    let hostport = 80;
    if (hostname.indexOf(':') > -1) {
        hostport = parseInt(hostname.substr(hostname.indexOf(':') + 1));
        hostname = hostname.substr(0, hostname.indexOf(':'));
    }

    let cameras = {};

    try {
        let profiles = await client.GetProfilesAsync({});
        for (let profile of profiles[0].Profiles) {
            let videoSource = profile.VideoSourceConfiguration.SourceToken;

            if (!cameras[videoSource])
                cameras[videoSource] = [];

            let snapshotUri = await client.GetSnapshotUriAsync({
                ProfileToken: profile.attributes.token
            });

            let streamUri = await client.GetStreamUriAsync({
                StreamSetup: {
                    Stream: 'RTP-Unicast',
                    Transport: {
                        Protocol: 'RTSP'
                    }
                },
                ProfileToken: profile.attributes.token
            });

            profile.streamUri = streamUri[0].MediaUri.Uri;
            profile.snapshotUri = snapshotUri[0].MediaUri.Uri;
            cameras[videoSource].push(profile);
        }
    } catch (err) {
        if (err.root && err.root.Envelope && err.root.Envelope.Body && err.root.Envelope.Body.Fault && err.root.Envelope.Body.Fault.Reason && err.root.Envelope.Body.Fault.Reason.Text)
            throw new Error(`Error: ${err.root.Envelope.Body.Fault.Reason.Text['$value']}`);
        throw new Error(`Error: ${err.message}`);
    }

    let config = {
        onvif: []
    };

    let serverPort = 8081;
    for (let camera in cameras) {
        let mainStream = cameras[camera][0];
        let subStream = cameras[camera][cameras[camera].length > 1 ? 1 : 0];

        let swapStreams = false;
        if (subStream.VideoEncoderConfiguration.Quality > mainStream.VideoEncoderConfiguration.Quality)
            swapStreams = true;
        else if (subStream.VideoEncoderConfiguration.Quality == mainStream.VideoEncoderConfiguration.Quality)
            if (subStream.VideoEncoderConfiguration.Resolution.Width > mainStream.VideoEncoderConfiguration.Resolution.Width)
                swapStreams = true;

        if (swapStreams) {
            let tempStream = subStream;
            subStream = mainStream;
            mainStream = tempStream;
        }

        let cameraConfig = {
            mac: '<ONVIF PROXY MAC ADDRESS HERE>',
            ports: {
                server: serverPort,
                rtsp: 8554,
                snapshot: 8580
            },
            name: mainStream.VideoSourceConfiguration.Name,
            uuid: uuid.v4(),
            highQuality: {
                rtsp: extractPath(mainStream.streamUri),
                snapshot: extractPath(mainStream.snapshotUri),
                width: mainStream.VideoEncoderConfiguration.Resolution.Width,
                height: mainStream.VideoEncoderConfiguration.Resolution.Height,
                framerate: mainStream.VideoEncoderConfiguration.RateControl.FrameRateLimit,
                bitrate: mainStream.VideoEncoderConfiguration.RateControl.BitrateLimit,
                quality: 4.0
            },
            lowQuality: {
                rtsp: extractPath(subStream.streamUri),
                snapshot: extractPath(subStream.snapshotUri),
                width: subStream.VideoEncoderConfiguration.Resolution.Width,
                height: subStream.VideoEncoderConfiguration.Resolution.Height,
                framerate: subStream.VideoEncoderConfiguration.RateControl.FrameRateLimit,
                bitrate: subStream.VideoEncoderConfiguration.RateControl.BitrateLimit,
                quality: 1.0
            },
            target: {
                hostname: hostname,
                ports: {
                    rtsp: 554,
                    snapshot: hostport
                }
            }
        };

        config.onvif.push(cameraConfig);
        serverPort++;
    }

    return config;
}

exports.createConfig = async function(hostname, username, password, logger) {

    const log = {
        info: (message) => logger && logger.info ? logger.info(message) : console.log(message),
        warn: (message) => logger && logger.warn ? logger.warn(message) : console.warn(message),
        error: (message) => logger && logger.error ? logger.error(message) : console.error(message)
    };

    const toError = (err) => {
        if (err instanceof Error)
            return err;
        if (typeof err === 'string')
            return new Error(err);
        try {
            return new Error(JSON.stringify(err));
        } catch (_) {
            return new Error(String(err));
        }
    };

    try {
        return await createConfig(hostname, username, password);
    } catch (err) {
        const initialError = toError(err);
        log.error(`Failed to create config on initial attempt: ${initialError.message}`);
        if (initialError.stack)
            log.error(initialError.stack);

        if (initialError.message && initialError.message.includes('time check failed')) {
            log.warn('Encountered time check failure. Retrying with adjusted UTC hour offset.');

            const originalGetUTCHours = Date.prototype.getUTCHours;
            Date.prototype.getUTCHours = function() {
                return originalGetUTCHours.call(this) + 1;
            };

            try {
                const config = await createConfig(hostname, username, password);
                log.info('Config created successfully after retry.');
                return config;
            } catch (retryErr) {
                const retryError = toError(retryErr);
                log.error(`Retry attempt to create config failed: ${retryError.message}`);
                if (retryError.stack)
                    log.error(retryError.stack);
                throw retryError;
            } finally {
                Date.prototype.getUTCHours = originalGetUTCHours;
            }
        }

        throw initialError;
    }
}
