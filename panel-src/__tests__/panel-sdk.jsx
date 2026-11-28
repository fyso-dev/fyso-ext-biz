import es from '../locales/es.json';
import { hostMessages } from './host-messages.mjs';

export { useEffect, useRef, useState } from 'react';

const messages = { ...hostMessages.es, ...es };
const lookup = key => key.split('.').reduce((entry, part) => entry?.[part], messages);

export function translate(key, options = {}) {
  const suffix = options.count === 1 ? 'one' : 'other';
  const value = (typeof options.count === 'number' ? lookup(`${key}_${suffix}`) : undefined) ?? lookup(key);
  return (typeof value === 'string' ? value : options.defaultValue ?? key)
    .replace(/{{(\w+)}}/g, (token, name) => options[name] ?? token);
}

export function useTranslation() {
  return { t: translate, i18n: { language: 'es' } };
}

const store = {
  backend: {},
  reload() {},
  extensions: { status: 'ok', data: [{ id: 'biz', secrets: [] }] },
  runtimeBots: { status: 'ok', data: [{ id: 'agent', name: 'Agent' }] },
};

export function useStore() {
  return store;
}

export function useDaguAction(_backend, workflow, outputKey) {
  return {
    phase: 'idle',
    async start(params) {
      const response = await fetch(`/test/dagu/${workflow}`, {
        method: 'POST',
        body: JSON.stringify(params),
      });
      if (!response.ok) return undefined;
      const { outputs = {} } = await response.json();
      const value = outputs[outputKey] ?? outputs[outputKey.toLowerCase()];
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    },
  };
}

export function RelTime({ at }) {
  return <time dateTime={at}>{at}</time>;
}

export function External({ href, children }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}
