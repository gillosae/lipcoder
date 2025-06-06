// scripts/download-silero-models.js
const { mkdirSync, existsSync, createWriteStream } = require('fs');
const { join } = require('path');
const https = require('https');

/**
 * Download a file from `url` and save it into `destPath`.
 * Automatically follows 301/302 redirects.
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            // Handle redirect (GitHub Release assets typically 302 => S3 URL)
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                if (!redirectUrl) {
                    return reject(new Error(`Redirected without a Location header: ${url}`));
                }
                // Recursively follow the redirect
                return downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url} (status ${response.statusCode})`));
            }

            // Pipe data into the file
            const fileStream = createWriteStream(destPath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(resolve);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

async function main() {
    // 1) Define where you want the models to live (relative to repo root)
    const modelDir = join(__dirname, '..', 'client', 'src', 'models', 'silero', 'en');
    mkdirSync(modelDir, { recursive: true });

    // 2) List of [filename, url] pairs
    const filesToDownload = [
        [
            'v3_en.pt',
            'https://github.com/gillosae/lipcoder/releases/download/v1.0.0/v3_en.pt'
        ],
        [
            'v3_en_indic.pt',
            'https://github.com/gillosae/lipcoder/releases/download/v1.0.0/v3_en_indic.pt'
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