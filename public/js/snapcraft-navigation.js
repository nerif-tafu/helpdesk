// Snapcraft.io sliding navigation (listeners.ts + dropdownUtils.ts, without global-nav)

const ANIMATION_DURATION = 333;

function setActiveDropdown(dropdownToggleButton, isActive = true) {
  const dropdownToggleEl = dropdownToggleButton.closest(
    '.p-navigation__item--dropdown-toggle'
  );
  if (dropdownToggleEl) {
    dropdownToggleEl.classList.toggle('is-active', isActive);
    dropdownToggleEl.classList.toggle('is-selected', isActive);
    const link = dropdownToggleEl.querySelector(':scope > .p-navigation__link');
    if (link) {
      link.setAttribute('aria-expanded', String(isActive));
      link.classList.toggle('is-selected', isActive);
    }
  }

  const parentLevelDropdown = dropdownToggleEl?.closest('.p-navigation__dropdown');
  if (parentLevelDropdown) {
    parentLevelDropdown.classList.toggle('is-active', isActive);
  }

  const topLevelNavigation = dropdownToggleButton.closest('.p-navigation__nav');
  if (topLevelNavigation) {
    const topLevelItems = topLevelNavigation.querySelectorAll(':scope > .p-navigation__items');
    for (const item of topLevelItems) {
      if (item.contains(dropdownToggleButton)) {
        item.classList.toggle('is-active', isActive);
      } else {
        item.classList.toggle('u-hide', isActive);
      }
    }
  }
}

function setListFocusable(list) {
  if (!list) return;
  for (const item of list.children) {
    if (item.children[0]) item.children[0].setAttribute('tabindex', '0');
  }
}

function setFocusable(target) {
  const isList =
    target.classList.contains('p-navigation__dropdown') ||
    target.classList.contains('p-navigation__items');

  if (!isList) {
    target.querySelectorAll('.p-navigation__dropdown').forEach(setListFocusable);
  } else {
    setListFocusable(target);
  }
}

function collapseDropdown(dropdownToggleButton, targetDropdown) {
  targetDropdown.setAttribute('aria-hidden', 'true');
  setActiveDropdown(dropdownToggleButton, false);
}

function expandDropdown(dropdownToggleButton, targetDropdown) {
  setActiveDropdown(dropdownToggleButton, true);
  targetDropdown.setAttribute('aria-hidden', 'false');
  setFocusable(targetDropdown);
}

function setupAnimationStart(elements) {
  elements.forEach((toggle) => {
    const parent = toggle.parentElement;
    if (!parent) return;
    parent.classList.add('js-animation-playing');
    void parent.offsetWidth;
    setTimeout(() => parent.classList.remove('js-animation-playing'), ANIMATION_DURATION);
  });
}

function initSnapcraftNavigation() {
  const navigation = document.querySelector('.p-navigation--sliding');
  if (!navigation) return;

  const menuButton = navigation.querySelector(
    '.p-navigation__banner .js-menu-button'
  );
  if (!menuButton) return;

  const toggles = [
    ...navigation.querySelectorAll(
      '.p-navigation__nav .p-navigation__link[aria-controls]:not(.js-back-button)'
    ),
  ];
  const topNavItemsLists = navigation.querySelectorAll('.p-navigation__nav > .p-navigation__items');
  const dropdownLinksLists = navigation.querySelectorAll('.p-navigation__dropdown');

  const unfocusAllLinks = () => {
    dropdownLinksLists.forEach((list) => {
      list.querySelectorAll('ul > li > a, ul > li > button').forEach((el) => {
        el.setAttribute('tabindex', '-1');
      });
    });
  };

  const collapseAllDropdowns = (excludedTarget) => {
    toggles.forEach((toggle) => {
      const ariaControls = toggle.getAttribute('aria-controls');
      if (!ariaControls) return;
      const target = document.getElementById(ariaControls);
      if (target && target !== excludedTarget) {
        collapseDropdown(toggle, target);
      }
    });
  };

  const closeMenu = () => {
    navigation.classList.add('menu-closing');
    setTimeout(() => {
      navigation.classList.remove('has-menu-open', 'menu-closing');
    }, ANIMATION_DURATION);
  };

  const resetNavigation = () => {
    collapseAllDropdowns();
    closeMenu();
    menuButton.innerHTML = 'Menu';
    document.body.style.overflow = '';
  };

  menuButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (navigation.classList.contains('has-menu-open')) {
      resetNavigation();
    } else {
      navigation.classList.add('has-menu-open');
      unfocusAllLinks();
      menuButton.innerHTML = 'Close menu';
      topNavItemsLists.forEach(setFocusable);
      document.body.style.overflow = 'hidden';
    }
  });

  toggles.forEach((toggle) => {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      setupAnimationStart(toggles);
      const ariaControls = toggle.getAttribute('aria-controls');
      if (!ariaControls) return;
      const target = document.getElementById(ariaControls);
      if (!target?.parentNode) return;

      const isNested = !!target.parentNode.closest?.('.p-navigation__dropdown');
      if (!isNested) collapseAllDropdowns(target);

      if (target.getAttribute('aria-hidden') === 'true') {
        unfocusAllLinks();
        expandDropdown(toggle, target);
        navigation.classList.add('has-menu-open');
      } else {
        collapseDropdown(toggle, target);
        if (!isNested) closeMenu();
      }
      e.stopPropagation();
    });
  });

  navigation.querySelectorAll('.js-back-button').forEach((backButton) => {
    backButton.addEventListener('click', (e) => {
      e.preventDefault();
      const target = backButton.closest('.p-navigation__dropdown');
      if (!target?.parentNode) return;
      unfocusAllLinks();
      if (target.parentNode.parentNode) {
        setFocusable(target.parentNode.parentNode);
      }
      const link = target.parentNode.querySelector('.p-navigation__link');
      if (link instanceof HTMLElement) link.focus();
      target.setAttribute('aria-hidden', 'true');
      setActiveDropdown(backButton, false);
    });
  });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const topNavigationElement = target.closest(
      '.p-navigation, .p-navigation--sliding, .p-navigation--reduced'
    );
    if (!topNavigationElement) {
      setupAnimationStart(toggles);
      resetNavigation();
    }
  });
}

window.addEventListener('load', initSnapcraftNavigation);
