function retryAfterSeconds(error) {
  const value = Number(error?.retryAfterSeconds);
  return Number.isInteger(value) && value > 0 ? value : 60;
}

export function createCaptchaController(options) {
  const {
    form,
    image,
    loginButton,
    refreshButton,
    requestChallenge,
    onRateLimited = () => {},
    onRetryRecovered = () => {},
    onRetryFailed = () => {},
    setTimer = (callback, delay) => window.setTimeout(callback, delay),
    clearTimer = timer => window.clearTimeout(timer),
  } = options;
  let retryTimer = null;

  function cancelRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function invalidate() {
    form.elements.captchaToken.value = '';
    form.elements.captchaCode.value = '';
    image.removeAttribute('src');
    image.classList.add('captcha-unavailable');
    loginButton.disabled = true;
  }

  function scheduleRetry(error) {
    cancelRetry();
    const seconds = retryAfterSeconds(error);
    onRateLimited(seconds);
    retryTimer = setTimer(async () => {
      retryTimer = null;
      try {
        await load({ automaticRetry: true });
      } catch (retryError) {
        if (retryError?.status !== 429) onRetryFailed(retryError);
      }
    }, seconds * 1000);
  }

  async function load({ invalidateExisting = false, automaticRetry = false } = {}) {
    cancelRetry();
    if (invalidateExisting) invalidate();
    const existingToken = form.elements.captchaToken.value;
    loginButton.disabled = true;
    refreshButton.disabled = true;
    try {
      const challenge = await requestChallenge();
      image.src = challenge.image;
      image.classList.remove('captcha-unavailable');
      form.elements.captchaToken.value = challenge.captchaToken;
      form.elements.captchaCode.value = '';
      loginButton.disabled = false;
      if (automaticRetry) onRetryRecovered();
      return challenge;
    } catch (error) {
      if (existingToken) loginButton.disabled = false;
      else image.classList.add('captcha-unavailable');
      if (error?.status === 429) scheduleRetry(error);
      throw error;
    } finally {
      refreshButton.disabled = false;
    }
  }

  return {
    load,
    invalidate,
    dispose: cancelRetry,
  };
}
