# Scratchpad

## Lessons Learned

### resemble-perth / chatterbox-tts NoneType error
- `resemble-perth` has a try/except in `__init__.py` that silently sets `PerthImplicitWatermarker = None` when the import fails
- This causes `TypeError: 'NoneType' object is not callable` when chatterbox tries to call `perth.PerthImplicitWatermarker()`
- The real error is hidden — it's a missing system dependency, not a Python issue
- `resemble-perth` requires system packages: `libsox-dev`, `sox`, `rubberband-cli` (for the `sox` and `pyrubberband` Python packages)
- Fix: add these to `.apt_install()` in the Modal image definition
- Lesson: when you see `'NoneType' object is not callable`, check for conditional imports that silently swallow ImportErrors

### Actual root cause: missing `setuptools` (pkg_resources)
- The PyPI release of `resemble-perth` 1.0.1 uses `from pkg_resources import resource_filename` in `perth/perth_net/__init__.py`
- The GitHub master branch was updated to use `importlib.resources` but that change hasn't been released to PyPI yet
- `uv` doesn't install `setuptools` by default (unlike pip), so `pkg_resources` is missing
- Fix: add `setuptools` to `pyproject.toml` dependencies
- The diagnostic approach of importing directly (bypassing the try/except) was key to finding this
- Lesson: when debugging silent import failures, bypass the try/except to see the real error

### REAL root cause: wrong `perth` PyPI package shadowing `resemble-perth`
- PyPI has TWO packages that provide a `perth` module: `perth` (1.0.0, 1.7KB, unrelated) and `resemble-perth` (1.0.1, 34MB, the real one)
- `chatterbox-tts` depends on `resemble-perth` which installs as the `perth` Python module
- Adding `perth>=1.0.0` to pyproject.toml installed the WRONG tiny package, which shadowed the real `perth` module from `resemble-perth`
- The wrong package doesn't have `PerthImplicitWatermarker`, so `perth.__init__.py`'s try/except set it to `None`
- Fix: remove `perth` from pyproject.toml — `resemble-perth` is already pulled in transitively via `chatterbox-tts`
- Lesson: ALWAYS check if a PyPI package name matches its import name — they can differ and conflict
- Lesson: use `run_commands` in Modal image builds to validate imports at build time, not runtime

### uv_sync vs pip_install on Modal — setuptools not surviving to runtime
- `uv_sync` installs packages into `/.uv/.venv/` during image build, but Modal's runtime mounts a separate Python environment at `/pkg/`
- Even though `setuptools` was in `pyproject.toml` and the lockfile, and `uv sync` installed it at build time, it was NOT available at runtime
- `run_commands("uv pip install setuptools")` also showed "Audited 1 package" (already installed) but still missing at runtime
- `.pip_install()` uses Modal's native pip integration which installs into the environment Modal's runtime actually uses — so packages survive
- **Resolution**: switched from `.uv_sync()` to `.pip_install()` with all deps listed explicitly
- Lesson: when using Modal, `.pip_install()` is more reliable than `.uv_sync()` for packages that need `setuptools`/`pkg_resources`
- Lesson: build-time validation (`run_commands`) can pass while runtime still fails due to different environments
- Once `resemble-perth` releases a new version using `importlib.resources` instead of `pkg_resources`, `uv_sync` should work fine
