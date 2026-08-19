// Contract between the Playwright suite and the front end. Names are semantic (what the
// element IS) so the same suite can be pointed at the future React rewrite unchanged.

export const TITLE = 'title';

export const LOGIN_SCREEN = 'login-screen';
export const APP_ROOT = 'app-root';
export const LOGIN_USERNAME_INPUT = 'login-username-input';
export const LOGIN_PASSWORD_INPUT = 'login-password-input';
export const LOGIN_SUBMIT_BUTTON = 'login-submit-button';
export const LOGIN_ERROR = 'login-error';

export const DEDUCT_OPEN_BUTTON = 'deduct-open-button';
export const ADD_OPEN_BUTTON = 'add-open-button';

export const LOCATION_TAB_BUTTON = 'location-tab-button';

export const ITEM_CARD = 'item-card';
export const ITEM_LIST = 'item-list';
export const EMPTY_STATE = 'empty-state';
export const SEARCH_INPUT = 'search-input';
export const SORT_SELECT = 'sort-select';
export const SORT_DIR_BUTTON = 'sort-dir-button';
export const VIEW_MODE_TOGGLE = 'view-mode-toggle';

export const ITEM_BARCODE_INPUT = 'item-barcode-input';
export const ITEM_NAME_INPUT = 'item-name-input';
export const ITEM_QUANTITY_INPUT = 'item-quantity-input';
export const ITEM_CATEGORY_SELECT = 'item-category-select';
export const ITEM_FORM_SUBMIT_BUTTON = 'item-form-submit-button';
export const ADD_MODAL = 'add-modal';
export const DUP_CHECK_PANEL = 'dup-check-panel';
export const CATEGORY_SUGGEST_BLOCK = 'category-suggest-block';
export const CATEGORY_SUGGEST_SELECT = 'category-suggest-select';
export const CATEGORY_SUGGEST_CUSTOM_INPUT = 'category-suggest-custom-input';

// Stage 3 (React client item detail/editing) — new fields/controls the legacy DOM has no
// existing testid for. Buttons with unique, fixed accessible text (Cancel, Use this, Add as
// new item anyway, -, +) are targeted via getByRole/getByText instead, matching the existing
// convention in duplicate-detection.spec.js and multi-location.spec.js.
export const ITEM_LOCATION_SELECT = 'item-location-select';
export const ITEM_THRESHOLD_INPUT = 'item-threshold-input';
export const ITEM_PRICE_INPUT = 'item-price-input';
export const ITEM_VENDOR_INPUT = 'item-vendor-input';
export const ITEM_DATE_INPUT = 'item-date-input';
export const EDIT_ITEM_BUTTON = 'edit-item-button';
export const IGNORE_TOGGLE_BUTTON = 'ignore-toggle-button';
export const QTY_MINUS_BUTTON = 'qty-minus-button';
export const QTY_PLUS_BUTTON = 'qty-plus-button';
export const QTY_DISPLAY_BUTTON = 'qty-display-button';
export const QTY_MODAL = 'qty-modal';
export const QTY_MODAL_AMOUNT_INPUT = 'qty-modal-amount-input';
export const QTY_MODAL_LOCATION_SELECT = 'qty-modal-location-select';
export const QTY_MODAL_SUBMIT_BUTTON = 'qty-modal-submit-button';

export const DEDUCT_ACTION_CONTAINER = 'deduct-action-container';
export const DEDUCT_ITEM_ID = 'deduct-item-id';
export const DEDUCT_SEARCH_INPUT = 'deduct-search-input';
export const DEDUCT_LIST_ITEM = 'deduct-list-item';
export const DEDUCT_QUANTITY_INPUT = 'deduct-quantity-input';
export const DEDUCT_LOCATION_SELECT = 'deduct-location-select';
export const DEDUCT_RESET_BUTTON = 'deduct-reset-button';
export const DEDUCT_SUBMIT_BUTTON = 'deduct-submit-button';

export const TOAST_NOTIFICATION = 'toast-notification';

export const DETAILS_MODAL = 'details-modal';
export const DETAILS_TITLE = 'details-title';

export const INVOICE_IMPORT_MODAL = 'invoice-import-modal';
export const INVOICE_IMPORT_OPEN_BUTTON = 'invoice-import-open-button';
export const INVOICE_IMPORT_FILE_INPUT = 'invoice-import-file-input';
export const INVOICE_IMPORT_STAGING_CONTAINER = 'invoice-import-staging-container';
export const INVOICE_IMPORT_SUMMARY_LINE = 'invoice-import-summary-line';
export const INVOICE_IMPORT_COMMIT_BUTTON = 'invoice-import-commit-button';
export const INVOICE_IMPORT_LINE = 'invoice-import-line';
export const INVOICE_IMPORT_LINE_CATEGORY_SELECT = 'invoice-import-line-category-select';
export const INVOICE_IMPORT_LINE_LOCATION_SELECT = 'invoice-import-line-location-select';
export const INVOICE_IMPORT_LINE_QTY_INPUT = 'invoice-import-line-qty-input';
export const INVOICE_IMPORT_LINE_REVIEWED_CHECKBOX = 'invoice-import-line-reviewed-checkbox';

// Stage 5 (React client price history) — new fields/controls. DETAILS_MODAL/DETAILS_TITLE
// above were reserved in stage 3 for this exact view. The modal's Close button has unique,
// fixed accessible text and is targeted via getByRole, matching the existing convention.
export const VIEW_HISTORY_BUTTON = 'view-history-button';
export const DETAILS_LAST_PURCHASE = 'details-last-purchase';
export const DETAILS_LOWEST_PURCHASE = 'details-lowest-purchase';
export const PRICE_CHART = 'price-chart';
export const PRICE_HISTORY_TABLE_BODY = 'price-history-table-body';
export const PRICE_HISTORY_ROW = 'price-history-row';
export const PRICE_HISTORY_DELETE_BUTTON = 'price-history-delete-button';

// Stage 4 (React client barcode/crop/invoice-import) — new fields/controls. Buttons with
// unique, fixed accessible text (Cancel, Use this, Skip this line, Restore) are targeted via
// getByRole/getByText, matching the existing convention.
export const BARCODE_SCAN_BUTTON = 'barcode-scan-button';
export const BARCODE_SCANNER_MODAL = 'barcode-scanner-modal';
export const BARCODE_SCANNER_READER = 'barcode-scanner-reader';
export const SNAP_LABEL_BUTTON = 'snap-label-button';
export const SNAP_LABEL_FILE_INPUT = 'snap-label-file-input';
export const CROP_MODAL = 'crop-modal';
export const CROP_IMAGE = 'crop-image';
export const CROP_CONFIRM_BUTTON = 'crop-confirm-button';
export const LOCATION_SUGGEST_BLOCK = 'location-suggest-block';
export const LOCATION_SUGGEST_SELECT = 'location-suggest-select';
export const LOCATION_SUGGEST_CUSTOM_INPUT = 'location-suggest-custom-input';
