type TTabsTitle = {
    [key: string]: string | number;
};

type TDashboardTabIndex = {
    [key: string]: number;
};

export const tabs_title: TTabsTitle = Object.freeze({
    WORKSPACE: 'Workspace',
    CHART: 'Chart',
});

export const DBOT_TABS: TDashboardTabIndex = Object.freeze({
    DASHBOARD: 0,
    BOT_BUILDER: 1,
    CHART: 2,
    DIGIT_ANALYSIS: 3,
    MANUAL_TRADER: 4,
    DERIV_CHARTS: 5,
    TUTORIAL: 5, // Retain compatibility with older navigation links.
    FREE_BOTS: 6,
    ANALYSIS_TOOL: 7,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = [
    'id-dbot-dashboard',
    'id-bot-builder',
    'id-charts',
    'id-digit-analysis',
    'id-manual-trader',
    'id-tutorials',
    'id-free-bots',
    'id-analysis-tool',
];

export const DEBOUNCE_INTERVAL_TIME = 500;
