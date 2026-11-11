const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['dist/**', 'doc/**']
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            // the library runs in Node.js and in the browser
            globals: {
                ...globals.node,
                ...globals.browser
            }
        },
        rules: {
            // parameters are often kept for documentation
            'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
            'no-throw-literal': 'error',
            'no-loop-func': 'error',
            'no-self-compare': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-unreachable-loop': 'error',
            'array-callback-return': 'error',
            'semi': 'warn'
        }
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            globals: globals.mocha
        }
    }
];
