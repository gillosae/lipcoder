// scripts/download-silero-models.js

const { mkdirSync, existsSync, createWriteStream } = require('fs');
const { join } = require('path');
const https = require('https');
const { version } = require('../package.json');

/**
 * Download a file from `url` (private repo). If GITHUB_TOKEN is set,
 * send it as an Authorization header so GitHub will let you download
 * private‐repo release assets.
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        // Build request options, adding Authorization if GH_TOKEN is defined
        const token = process.env.GH_TOKEN || '';
        const options = new URL(url);
        if (token) {
            options.headers = {
                'Authorization': `token ${token}`,
                'User-Agent': 'node.js',
            };
        } else {
            // It’s a private repo, so 404 is expected if no token
            console.warn('Warning: GH_TOKEN is not set. Requests to private releases will fail.');
        }

        https
            .get(options, (response) => {
                const { statusCode, headers } = response;

                // Follow any redirect (3xx → headers.location)
                if (statusCode >= 300 && statusCode < 400 && headers.location) {
                    console.log(`↪ Redirect ${statusCode} → ${headers.location}`);
                    return downloadFile(headers.location, destPath)
                        .then(resolve)
                        .catch(reject);
                }

                // If not a successful 200, it’s an error (either 404 or some other failure)
                if (statusCode !== 200) {
                    return reject(
                        new Error(`Failed to download ${url} (status ${statusCode}). ` +
                            `Are you sure GH_TOKEN is correct and has repo:read permissions?`)
                    );
                }

                // statusCode === 200: write the file to disk
                const fileStream = createWriteStream(destPath);
                response.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close(resolve);
                });
            })
            .on('error', (err) => {
                reject(err);
            });
    });
}

async function main() {
    // 1) Build model directory: client/src/models/silero/en/
    const modelDir = join(__dirname, '..', 'client', 'src', 'models', 'silero', 'en');
    mkdirSync(modelDir, { recursive: true });

    // 2) Use v${version} as the release tag (so if version="0.0.1", we download from v0.0.1)
    const releaseTag = `v${version}`;

    // 3) List of [filename, URL] pairs pointing at your private‐repo release assets
    const filesToDownload = [
        [
            'v3_en.pt',
            // `https://github.com/gillosae/lipcoder/releases/download/${releaseTag}/v3_en.pt`,
            `https://models.silero.ai/models/tts/en/v3_en.pt`,
        ],
        [
            'v3_en_indic.pt',
            // `https://github.com/gillosae/lipcoder/releases/download/${releaseTag}/v3_en_indic.pt`,
            `https://models.silero.ai/models/tts/en/v3_en_indic.pt`,
        ],
    ];

    for (const [filename, url] of filesToDownload) {
        const destPath = join(modelDir, filename);
        if (existsSync(destPath)) {
            console.log(`${filename} already exists, skipping download.`);
            continue;
        }
        console.log(`Downloading ${filename} from ${url} ...`);
        try {
            await downloadFile(url, destPath);
            console.log(`→ Saved to ${destPath}`);
        } catch (e) {
            console.error(`Failed to download ${filename}:`, e.message);
            process.exit(1);
        }
    }

    console.log('All Silero models are in place.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});