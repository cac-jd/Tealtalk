// Stand-in for public/js/api.js: tests set globalThis.__Api to the server they want.
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    if (data !== undefined) this.data = data;
  }
  get isNetwork() {
    return this.status === 0;
  }
  get isTransient() {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.status === 408;
  }
}
export const Api = new Proxy(
  {},
  {
    get: (_, k) => (...a) => {
      const fn = globalThis.__Api && globalThis.__Api[k];
      if (!fn) return Promise.reject(new ApiError(0, `no stub for Api.${String(k)}`));
      return fn(...a);
    },
  },
);
