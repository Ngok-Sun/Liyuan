/**
 * 梨园主题定义与换肤系统
 */

export interface ThemeDef {
	id: string;
	name: string;
	subtitle: string;
	isDark: boolean;
	accent: string;
	bg: string;
	surface: string;
	textColor: string;
	previewGrad: string;
}

export const THEME_LIST: ThemeDef[] = [
	{
		id: "zhusha",
		name: "白瓷朱砂", // i18n-ignore
		subtitle: "宣纸暖白 · 朱砂红印 · 国风雅正", // i18n-ignore
		isDark: false,
		accent: "#bc4123",
		bg: "#f7f4f0",
		surface: "#fffcfa",
		textColor: "#3d3833",
		previewGrad: "radial-gradient(circle at 50% 30%, #faf7f2 0%, #f7f4f0 70%, #ede6dc 100%)",
	},
	{
		id: "xuanhei",
		name: "玄黑赤金", // i18n-ignore
		subtitle: "暖墨暗调 · 赤金微芒 · 沉浸护眼", // i18n-ignore
		isDark: true,
		accent: "#e25a3c",
		bg: "#141110",
		surface: "#1e1a18",
		textColor: "#eee8e1",
		previewGrad: "radial-gradient(circle at 50% 30%, #201a18 0%, #141110 70%, #0d0b0a 100%)",
	},
	{
		id: "qinglv",
		name: "千里青绿", // i18n-ignore
		subtitle: "宋韵山水 · 竹青松绿 · 素雅温润", // i18n-ignore
		isDark: false,
		accent: "#2d6a4f",
		bg: "#f2f6f3",
		surface: "#fbfdfb",
		textColor: "#2b3831",
		previewGrad: "radial-gradient(circle at 50% 30%, #f4f8f5 0%, #eef4f0 70%, #dfede3 100%)",
	},
	{
		id: "qinghua",
		name: "青花瓷韵", // i18n-ignore
		subtitle: "素白瓷胎 · 霁蓝钴料 · 清冽幽邃", // i18n-ignore
		isDark: false,
		accent: "#1d4ed8",
		bg: "#f3f5fa",
		surface: "#ffffff",
		textColor: "#273042",
		previewGrad: "radial-gradient(circle at 50% 30%, #f8faff 0%, #f0f3fa 70%, #e0e7f7 100%)",
	},
	{
		id: "luoying",
		name: "落樱微雨", // i18n-ignore
		subtitle: "暮春柔粉 · 暖灰轻柔 · 惬意日常", // i18n-ignore
		isDark: false,
		accent: "#db2777",
		bg: "#faf4f5",
		surface: "#fffbfc",
		textColor: "#3d2c31",
		previewGrad: "radial-gradient(circle at 50% 30%, #fcf7f8 0%, #f9f2f4 70%, #f4e3e7 100%)",
	},
	{
		id: "canglang",
		name: "沧浪寒潭", // i18n-ignore
		subtitle: "幽邃夜色 · 天青湖蓝 · 冷峻明晰", // i18n-ignore
		isDark: true,
		accent: "#0284c7",
		bg: "#0f172a",
		surface: "#1e293b",
		textColor: "#f1f5f9",
		previewGrad: "radial-gradient(circle at 50% 30%, #172554 0%, #0f172a 70%, #080d1a 100%)",
	},
];

const THEME_ID_KEY = "liyuan.themeId";

export function getActiveThemeId(): string {
	try {
		const saved = localStorage.getItem(THEME_ID_KEY);
		if (saved && THEME_LIST.some((t) => t.id === saved)) return saved;
		const legacy = localStorage.getItem("liyuan.theme");
		if (legacy === "dark") return "xuanhei";
	} catch {
		// ignore
	}
	return "zhusha";
}

export function getActiveTheme(): ThemeDef {
	const id = getActiveThemeId();
	return THEME_LIST.find((t) => t.id === id) || THEME_LIST[0];
}

export function applyThemeById(id: string): void {
	const target = THEME_LIST.find((t) => t.id === id) || THEME_LIST[0];
	document.documentElement.setAttribute("data-theme-id", target.id);
	document.documentElement.setAttribute("data-theme", target.isDark ? "dark" : "light");

	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", target.bg);

	try {
		localStorage.setItem(THEME_ID_KEY, target.id);
		localStorage.setItem("liyuan.theme", target.isDark ? "dark" : "light");
	} catch {
		// ignore
	}
}

export interface WallpaperConfig {
	url: string;
	opacity: number;
	blur: number;
}

const WALLPAPER_KEY = "liyuan.wallpaper";
const CUSTOM_CSS_KEY = "liyuan.customCss";
const CUSTOM_CSS_ENABLED_KEY = "liyuan.customCssEnabled";

export function getWallpaperConfig(): WallpaperConfig | null {
	try {
		const raw = localStorage.getItem(WALLPAPER_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as WallpaperConfig;
		if (parsed && typeof parsed.url === "string") {
			return {
				url: parsed.url,
				opacity: typeof parsed.opacity === "number" ? parsed.opacity : 1.0,
				blur: typeof parsed.blur === "number" ? parsed.blur : 0,
			};
		}
	} catch {
		// ignore
	}
	return null;
}

export function applyWallpaper(cfg: WallpaperConfig | null): void {
	const root = document.documentElement;
	if (!cfg || !cfg.url) {
		root.style.removeProperty("--app-wallpaper-url");
		root.style.removeProperty("--app-wallpaper-opacity");
		root.style.removeProperty("--app-wallpaper-blur");
		root.removeAttribute("data-has-wallpaper");
		try { localStorage.removeItem(WALLPAPER_KEY); } catch {}
		window.dispatchEvent(new CustomEvent("liyuan:wallpaper-change", { detail: null }));
		return;
	}
	root.style.setProperty("--app-wallpaper-url", `url("${cfg.url}")`);
	root.style.setProperty("--app-wallpaper-opacity", String(cfg.opacity));
	root.style.setProperty("--app-wallpaper-blur", `${cfg.blur}px`);
	root.setAttribute("data-has-wallpaper", "true");
	try { localStorage.setItem(WALLPAPER_KEY, JSON.stringify(cfg)); } catch {}
	window.dispatchEvent(new CustomEvent("liyuan:wallpaper-change", { detail: cfg }));
}

export interface CustomCssState {
	enabled: boolean;
	code: string;
}

export function getCustomCss(): CustomCssState {
	try {
		const code = localStorage.getItem(CUSTOM_CSS_KEY) || "";
		const enabled = localStorage.getItem(CUSTOM_CSS_ENABLED_KEY) === "1";
		return { enabled, code };
	} catch {
		return { enabled: false, code: "" };
	}
}

export function applyCustomCss(state: CustomCssState): void {
	const STYLE_ID = "liyuan-user-custom-css";
	let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
	if (!state.enabled || !state.code.trim()) {
		if (styleEl) styleEl.remove();
	} else {
		if (!styleEl) {
			styleEl = document.createElement("style");
			styleEl.id = STYLE_ID;
			document.head.appendChild(styleEl);
		}
		styleEl.textContent = state.code;
	}
	try {
		localStorage.setItem(CUSTOM_CSS_KEY, state.code);
		localStorage.setItem(CUSTOM_CSS_ENABLED_KEY, state.enabled ? "1" : "0");
	} catch {}
}
