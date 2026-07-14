// @ts-check

const isNode = typeof window === 'undefined';
const nodeStorageValues = new Map();
const nodeStorage = {
	getItem(key) {
		return nodeStorageValues.has(key) ? nodeStorageValues.get(key) : null;
	},
	setItem(key, value) {
		nodeStorageValues.set(String(key), String(value));
	},
	removeItem(key) {
		nodeStorageValues.delete(key);
	}
};
const storage = isNode ? nodeStorage : window.localStorage;

const configuredAppBaseUrl = import.meta.env.VITE_BASE44_APP_BASE_URL;
const isLocalBrowser = !isNode && ['localhost', '127.0.0.1'].includes(window.location.hostname);
// In production and Base44 previews, authentication must stay on the origin
// that actually served this app. The previous hard-coded Base44 slug was later
// reassigned to another app, sending signed-out mobile visitors to its login.
const runtimeAppBaseUrl = isNode || isLocalBrowser
	? configuredAppBaseUrl
	: window.location.origin;

const toSnakeCase = (str) => {
	return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

const getAppParamValue = (paramName, { defaultValue = undefined, removeFromUrl = false } = {}) => {
	if (isNode) {
		return defaultValue;
	}
	const storageKey = `base44_${toSnakeCase(paramName)}`;
	const urlParams = new URLSearchParams(window.location.search);
	const searchParam = urlParams.get(paramName);
	if (removeFromUrl) {
		urlParams.delete(paramName);
		const newUrl = `${window.location.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ""
			}${window.location.hash}`;
		window.history.replaceState({}, document.title, newUrl);
	}
	if (searchParam) {
		storage.setItem(storageKey, searchParam);
		return searchParam;
	}
	if (defaultValue) {
		storage.setItem(storageKey, defaultValue);
		return defaultValue;
	}
	const storedValue = storage.getItem(storageKey);
	if (storedValue) {
		return storedValue;
	}
	return null;
}

const getAppParams = () => {
	if (getAppParamValue("clear_access_token") === 'true') {
		storage.removeItem('base44_access_token');
		storage.removeItem('token');
	}
	return {
		// App identity is build-controlled. Accepting a persisted app_id query
		// parameter could silently bind this UI to another Base44 application.
		appId: import.meta.env.VITE_BASE44_APP_ID,
		token: getAppParamValue("access_token", { removeFromUrl: true }),
		fromUrl: getAppParamValue("from_url", { defaultValue: isNode ? undefined : window.location.href }),
		appBaseUrl: runtimeAppBaseUrl,
	}
}


export const appParams = {
	...getAppParams()
}
