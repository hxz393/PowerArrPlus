  function startDomObserver() {
    const observer = new MutationObserver((mutations) => {
      if (
        state.toolbar &&
        mutations.every((mutation) => state.toolbar.contains(mutation.target))
      ) {
        return;
      }

      if (!state.toolbar) {
        ensureToolbar();
      } else {
        placeToolbar();
      }
      scheduleInjectCheckboxes();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden"],
      characterData: true,
    });
    window.addEventListener("resize", placeToolbar);
    window.addEventListener("scroll", placeToolbar, true);
    document.addEventListener(
      "click",
      () => {
        window.setTimeout(() => refreshCustomFiltersAndResync(), 100);
      },
      true
    );
  }

  installFetchHook();
  if (window.localStorage.getItem("powerarrPlusDisableXhrObserver") !== "1") {
    installXhrObserver();
  }
  installNativeSelectionInterceptor();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      addStyles();
      ensureToolbar();
      refreshCustomFiltersAndResync();
      startDomObserver();
    });
  } else {
    addStyles();
    ensureToolbar();
    refreshCustomFiltersAndResync();
    startDomObserver();
  }
