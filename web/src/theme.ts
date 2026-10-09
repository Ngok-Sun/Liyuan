/**
 * 昼夜主题：localStorage 持久化，html[data-theme] 驱动 CSS 变量。
 */

import {
	applyCustomCss,
	applyThemeById,
	applyWallpaper,
	getActiveTheme,
	getActiveThemeId,
	getCustomCss,
	getWallpaperConfig,
} from "./themes.ts";

export type ThemeMode = "light" | "dark";

export function getTheme(): ThemeMode {
	return getActiveTheme().isDark ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode): void {
	const cur = getActiveTheme();
	if (mode === "dark") {
		applyThemeById(cur.isDark ? cur.id : "xuanhei");
	} else {
		applyThemeById(!cur.isDark ? cur.id : "zhusha");
	}
}

export function setTheme(mode: ThemeMode): void {
	applyTheme(mode);
}

/** 启动时尽早调用，避免白闪 */
export function initTheme(): ThemeMode {
	const id = getActiveThemeId();
	applyThemeById(id);
	applyWallpaper(getWallpaperConfig());
	applyCustomCss(getCustomCss());
	return getActiveTheme().isDark ? "dark" : "light";
}
