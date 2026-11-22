// REG-036：离线播放器「退出全屏 → 锁竖屏 → 谁负责解锁」的状态对照。
//
// 真机行为要 XCTest/模拟器才能跑，本机（Windows）没有 Xcode，这里只把控制器里的判定顺序
// 原样建模：全屏切换 → 外层锁竖屏 → 延时解锁（带代数守卫）→ 设备姿态通知 → 界面旋转。
// 旧版（42104b6）只在「姿态通知里的全屏分支」补解锁，按钮/返回退出后就永远锁着，横拿不再自动全屏。
//
// 跑法：node --test ios/Tests/playerOrientation.test.mjs
import test from 'node:test';
import assert from 'node:assert';

/**
 * @param {'old'|'new'} version
 */
function makeController(version) {
  const controller = {
    isFullscreen: false,
    rotationLocked: false,      // WebViewController.offlineRotationLocked
    generation: 0,
    pendingUnlocks: [],         // DispatchQueue.main.asyncAfter 排队中的回调
    interfaceLandscape: false,
    deviceLandscapeHeld: false,
  };

  // 外层：onFullscreenChange 只把「用户主动退出全屏」写成锁竖屏
  const notifyOuter = (on, explicit) => {
    controller.rotationLocked = explicit && !on;
  };

  const scheduleUnlock = () => {
    const generation = controller.generation;
    controller.pendingUnlocks.push(() => {
      if (controller.generation !== generation) return;   // 这半秒里又进出过全屏 → 作废
      if (controller.isFullscreen) return;
      if (controller.deviceLandscapeHeld) return;         // 手还横着就不解
      controller.rotationLocked = false;
    });
  };

  const setFullscreen = (on, explicit = false) => {
    if (controller.isFullscreen === on) return;
    controller.isFullscreen = on;
    if (version === 'new') controller.generation += 1;
    controller.interfaceLandscape = on;
    notifyOuter(on, explicit);
    if (version === 'new' && !on && explicit) scheduleUnlock();
  };

  controller.tapFullscreen = () => setFullscreen(!controller.isFullscreen, true);
  controller.tapBack = () => {
    if (!controller.isFullscreen) return 'dismiss';
    setFullscreen(false, true);
    return 'exit';
  };

  controller.orientationChanged = () => {
    const portrait = !controller.deviceLandscapeHeld;
    if (controller.isFullscreen) {
      if (!portrait) return;
      setFullscreen(false, true);
      if (version === 'old') {
        controller.pendingUnlocks.push(() => {
          if (controller.isFullscreen) return;
          controller.rotationLocked = false;
        });
      }
      return;
    }
    if (controller.rotationLocked && portrait) controller.rotationLocked = false;
  };

  controller.rotateInterface = () => {
    if (controller.rotationLocked) return;   // 锁着竖屏，界面不会跟着转
    if (controller.deviceLandscapeHeld === controller.interfaceLandscape) return;
    controller.interfaceLandscape = controller.deviceLandscapeHeld;
    if (controller.interfaceLandscape && !controller.isFullscreen) setFullscreen(true, false);
    else if (!controller.interfaceLandscape && controller.isFullscreen) setFullscreen(false, false);
  };

  controller.advance = (seconds) => {
    if (seconds < 0.5) return;
    const due = controller.pendingUnlocks;
    controller.pendingUnlocks = [];
    due.forEach((job) => job());
  };

  return controller;
}

test('旧版复现审核给的场景：竖持点全屏→返回退出→再横拿，进不去全屏', () => {
  const c = makeController('old');
  c.tapFullscreen();
  c.advance(0.5);
  assert.strictEqual(c.isFullscreen, true);
  assert.strictEqual(c.rotationLocked, false);

  c.tapBack();
  assert.strictEqual(c.isFullscreen, false);
  assert.strictEqual(c.rotationLocked, true);

  c.advance(0.5);                 // 设备一直竖持，不会再有方向通知
  c.deviceLandscapeHeld = true;
  c.rotateInterface();

  assert.strictEqual(c.rotationLocked, true);
  assert.strictEqual(c.isFullscreen, false);
});

test('新版同一个场景：退出后按当前姿态解锁，横拿能自动进全屏', () => {
  const c = makeController('new');
  c.tapFullscreen();
  c.advance(0.5);
  c.tapBack();
  assert.strictEqual(c.rotationLocked, true);

  c.advance(0.5);
  assert.strictEqual(c.rotationLocked, false);

  c.deviceLandscapeHeld = true;
  c.rotateInterface();
  assert.strictEqual(c.isFullscreen, true);
});

test('新版：手还横着点退出时先不解锁，回到竖持才解', () => {
  const c = makeController('new');
  c.deviceLandscapeHeld = true;
  c.tapFullscreen();
  c.advance(0.5);

  c.tapBack();
  c.advance(0.5);
  assert.strictEqual(c.rotationLocked, true);

  c.deviceLandscapeHeld = false;
  c.orientationChanged();
  assert.strictEqual(c.rotationLocked, false);

  c.deviceLandscapeHeld = true;
  c.rotateInterface();
  assert.strictEqual(c.isFullscreen, true);
});

test('新版：上一次退出排的延时回调不会解开新一次退出的锁', () => {
  const c = makeController('new');
  c.tapFullscreen();              // gen1
  c.advance(0.5);
  c.tapBack();                    // gen2 退出，排了回调 A
  c.tapFullscreen();              // gen3 再进全屏
  c.tapBack();                    // gen4 再退出，排了回调 B
  assert.strictEqual(c.rotationLocked, true);

  const firstScheduled = c.pendingUnlocks.shift();   // 只放行最早那个（属于 gen2）
  firstScheduled();
  assert.strictEqual(c.rotationLocked, true, 'gen2 的回调不能解开 gen4 的锁');

  c.advance(0.5);
  assert.strictEqual(c.rotationLocked, false, '属于 gen4 的回调正常解锁');
});

test('新版：系统旋转引起的退出不算主动退出，不锁方向', () => {
  const c = makeController('new');
  c.deviceLandscapeHeld = true;
  c.rotateInterface();
  assert.strictEqual(c.isFullscreen, true);
  assert.strictEqual(c.rotationLocked, false);

  c.deviceLandscapeHeld = false;
  c.rotateInterface();
  assert.strictEqual(c.isFullscreen, false);
  assert.strictEqual(c.rotationLocked, false);

  c.advance(0.5);
  assert.strictEqual(c.rotationLocked, false);
});

test('新版：全屏时竖持手机 → 姿态通知退出全屏并随后解锁', () => {
  const c = makeController('new');
  c.tapFullscreen();
  c.advance(0.5);

  c.deviceLandscapeHeld = false;
  c.orientationChanged();
  assert.strictEqual(c.isFullscreen, false);
  assert.strictEqual(c.rotationLocked, true);

  c.advance(0.5);
  assert.strictEqual(c.rotationLocked, false);
});