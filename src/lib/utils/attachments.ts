const INLINE_IMAGE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/bmp',
	'image/tiff',
	'image/x-icon',
	'image/vnd.microsoft.icon'
]);

function mimeType(contentType: string): string {
	return contentType.split(';', 1)[0].trim().toLowerCase();
}

/** Only passive raster formats can be opened from this application's origin. */
export function isImageType(contentType: string): boolean {
	return INLINE_IMAGE_TYPES.has(mimeType(contentType));
}

export function isPreviewableInline(contentType: string): boolean {
	const type = mimeType(contentType);
	return INLINE_IMAGE_TYPES.has(type) || type === 'text/plain' || type === 'application/json';
}

export function attachmentHref(emailId: string, attachmentId: string, download = false): string {
	const base = `/api/mail/${emailId}/attachments/${attachmentId}`;
	return download ? `${base}?download=1` : base;
}

export function attachmentIcon(contentType: string): string {
	if (isImageType(contentType)) return 'image-line';
	if (contentType === 'application/pdf') return 'file-pdf-line';
	if (contentType.startsWith('text/')) return 'file-text-line';
	if (contentType.includes('zip') || contentType.includes('compressed')) return 'file-zip-line';
	return 'file-3-line';
}
