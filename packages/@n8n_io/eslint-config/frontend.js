/**
 * @type {import('@types/eslint').ESLint.ConfigData}
 */
module.exports = {
	plugins: ['vue'],

	extends: ['plugin:vue/essential', '@vue/typescript', './base'],

	env: {
		browser: true,
		es6: true,
		node: true,
	},

	ignorePatterns: ['**/*.js', '**/*.d.ts', 'vite.config.ts', '**/*.ts.snap'],

	rules: {
		'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		semi: [2, 'always'],
		'comma-dangle': ['error', 'always-multiline'],
		'no-tabs': 0,
		'no-labels': 0,
		'vue/no-deprecated-slot-attribute': 'error',
		'vue/no-deprecated-slot-scope-attribute': 'error',
		'vue/no-multiple-template-root': 'error',
		'vue/v-slot-style': 'error',

		// TODO: remove these
		'vue/no-unused-components': 'warn',
		'vue/return-in-computed-property': 'warn',
		'vue/no-mutating-props': 'warn',
		'@typescript-eslint/no-floating-promises': 'warn',
	},
};
