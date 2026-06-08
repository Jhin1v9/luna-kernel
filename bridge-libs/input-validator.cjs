/**
 * InputValidator — guard clauses for all public methods.
 * Fail fast with clear error messages.
 */
class InputValidator {
  static userId(userId, label = 'userId') {
    if (!userId || typeof userId !== 'string') {
      throw new Error(`${label} is required and must be a string`);
    }
    if (userId.length > 256) {
      throw new Error(`${label} too long (max 256 chars)`);
    }
    return userId;
  }

  static text(text, label = 'text') {
    if (text === undefined || text === null) {
      throw new Error(`${label} is required`);
    }
    if (typeof text !== 'string') {
      throw new Error(`${label} must be a string`);
    }
    return text;
  }

  static options(options, label = 'options') {
    if (options && typeof options !== 'object') {
      throw new Error(`${label} must be an object`);
    }
    return options || {};
  }

  static base64(data, label = 'base64') {
    if (!data || typeof data !== 'string') {
      throw new Error(`${label} is required and must be a base64 string`);
    }
    if (!/^data:.*?;base64,/.test(data) && !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new Error(`${label} does not look like valid base64`);
    }
    return data;
  }

  static page(page, label = 'page') {
    if (!page || typeof page.evaluate !== 'function') {
      throw new Error(`${label} must be a valid Playwright Page`);
    }
    return page;
  }

  static mode(mode) {
    const valid = ['instant', 'thinking', 'agent', 'swarm'];
    if (mode && !valid.includes(mode)) {
      throw new Error(`mode must be one of: ${valid.join(', ')}`);
    }
    return mode || 'instant';
  }
}

module.exports = { InputValidator };
