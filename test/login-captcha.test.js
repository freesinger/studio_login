import { describe, expect, it, vi } from 'vitest';

import { createCaptchaController } from '../public/login-captcha.js';

function fixture(requestChallenge) {
  const classes = new Set();
  const image = {
    src: 'data:image/png;base64,old',
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    },
    removeAttribute: vi.fn(function removeAttribute(name) {
      if (name === 'src') this.src = '';
    }),
  };
  const form = {
    elements: {
      captchaToken: { value: 'old-token' },
      captchaCode: { value: 'OLD12' },
    },
  };
  const loginButton = { disabled: false };
  const refreshButton = { disabled: false };
  const timers = [];
  const onRateLimited = vi.fn();
  const onRetryRecovered = vi.fn();
  const onRetryFailed = vi.fn();
  const controller = createCaptchaController({
    form,
    image,
    loginButton,
    refreshButton,
    requestChallenge,
    onRateLimited,
    onRetryRecovered,
    onRetryFailed,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer: vi.fn(),
  });
  return {
    controller,
    form,
    image,
    loginButton,
    refreshButton,
    timers,
    onRateLimited,
    onRetryRecovered,
    onRetryFailed,
  };
}

function rateLimited(seconds = 17) {
  return Object.assign(new Error('操作过于频繁，请稍后再试'), {
    status: 429,
    retryAfterSeconds: seconds,
  });
}

describe('login captcha controller', () => {
  it('keeps the current captcha usable when a manual refresh is rate limited', async () => {
    const state = fixture(vi.fn().mockRejectedValue(rateLimited()));

    await expect(state.controller.load()).rejects.toThrow('操作过于频繁');

    expect(state.form.elements.captchaToken.value).toBe('old-token');
    expect(state.form.elements.captchaCode.value).toBe('OLD12');
    expect(state.image.src).toBe('data:image/png;base64,old');
    expect(state.loginButton.disabled).toBe(false);
    expect(state.refreshButton.disabled).toBe(false);
    expect(state.onRateLimited).toHaveBeenCalledWith(17);
    expect(state.timers).toHaveLength(1);
    expect(state.timers[0].delay).toBe(17_000);
  });

  it('hides an invalidated image and automatically recovers after Retry-After', async () => {
    const requestChallenge = vi.fn()
      .mockRejectedValueOnce(rateLimited(3))
      .mockResolvedValueOnce({
        captchaToken: 'new-token',
        image: 'data:image/png;base64,new',
      });
    const state = fixture(requestChallenge);

    await expect(state.controller.load({ invalidateExisting: true })).rejects.toThrow();
    expect(state.form.elements.captchaToken.value).toBe('');
    expect(state.form.elements.captchaCode.value).toBe('');
    expect(state.image.src).toBe('');
    expect(state.image.classList.contains('captcha-unavailable')).toBe(true);
    expect(state.loginButton.disabled).toBe(true);

    await state.timers[0].callback();

    expect(requestChallenge).toHaveBeenCalledTimes(2);
    expect(state.form.elements.captchaToken.value).toBe('new-token');
    expect(state.image.src).toBe('data:image/png;base64,new');
    expect(state.image.classList.contains('captcha-unavailable')).toBe(false);
    expect(state.loginButton.disabled).toBe(false);
    expect(state.onRetryRecovered).toHaveBeenCalledOnce();
    expect(state.onRetryFailed).not.toHaveBeenCalled();
  });
});
