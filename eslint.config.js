import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
    {ignores: ['dist', 'test-sprays']},
    js.configs.recommended,
    {
        files: ['src/**/*.{js,jsx}'],
        languageOptions: {
            globals: globals.browser,
            parserOptions: {ecmaFeatures: {jsx: true}},
        },
        settings: {react: {version: 'detect'}},
        plugins: {react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh},
        rules: {
            ...react.configs.recommended.rules,
            ...react.configs['jsx-runtime'].rules,
            ...reactHooks.configs.recommended.rules,
            'react-refresh/only-export-components': 'warn',
            // Plain JS project: propTypes would be the only runtime type checks in it.
            'react/prop-types': 'off',
        },
    },
    {
        files: ['src/encoderWorker.js'],
        languageOptions: {globals: globals.worker},
    },
    {
        files: ['scripts/**/*.mjs', 'test/**/*.js', 'eslint.config.js', 'vite.config.js'],
        languageOptions: {globals: globals.node},
    },
]
