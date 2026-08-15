export class CanvasPackageTrustConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CanvasPackageTrustConfigurationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CanvasPackageTrustConfigurationError(code, message);
}

function clean(value) {
  return String(value ?? '').trim();
}

function runtimeEnvironment() {
  return import.meta.env || {};
}

/**
 * Returns the public-key trust anchor compiled into the web application.
 *
 * The assignment-package endpoint is deliberately not a trust source. It may
 * advertise which key signed a package for diagnostics, but only these pinned
 * build values can authorize a field package on a rep device.
 */
export function getCanvasPackageTrustConfig(environment = runtimeEnvironment()) {
  const keyId = clean(environment?.VITE_CANVAS_PACKAGE_SIGNING_KEY_ID);
  const keyData = clean(environment?.VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY).replaceAll('\\n', '\n');
  const format = clean(environment?.VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT || 'spki').toLowerCase();
  if (!keyId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    fail(
      'CANVAS_PACKAGE_TRUST_NOT_CONFIGURED',
      'Canvas field-package verification key ID is not configured in this app build.',
    );
  }
  if (!keyData) {
    fail(
      'CANVAS_PACKAGE_TRUST_NOT_CONFIGURED',
      'Canvas field-package verification public key is not configured in this app build.',
    );
  }
  if (!['raw', 'spki', 'jwk'].includes(format)) {
    fail(
      'CANVAS_PACKAGE_TRUST_NOT_CONFIGURED',
      'Canvas field-package verification public-key format is unsupported.',
    );
  }
  let parsedKeyData = keyData;
  if (format === 'jwk') {
    try {
      parsedKeyData = JSON.parse(keyData);
    } catch {
      fail('CANVAS_PACKAGE_TRUST_NOT_CONFIGURED', 'Canvas field-package verification JWK is invalid.');
    }
  }
  return Object.freeze({
    algorithm: 'Ed25519',
    keyId,
    key_id: keyId,
    format,
    keyData: parsedKeyData,
  });
}
