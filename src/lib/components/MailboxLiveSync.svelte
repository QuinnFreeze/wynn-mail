<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { startMailboxLiveSync } from '$lib/mail/live';

	$effect(() => startMailboxLiveSync(invalidate));
</script>
