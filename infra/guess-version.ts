const package_json = require('../package.json');
const fs = require('fs');
const guess_version = package_json.version;
const runtime = 'packages/guess-webpack/src/runtime/runtime.ts';

const replaceGuessVersion = (error: Error, data: string) => {
    if (error) {
        throw error;
    }

    const result = data.replace('guessVersion = \'\'', `guessVersion = '${guess_version}'`);

    fs.writeFile(runtime, result, 'utf8', (err: Error) => {
        if (err) {
            throw error;
        }
    });
}

fs.readFile(runtime, 'utf8', replaceGuessVersion);
