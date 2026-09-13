/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * VSR - Interco Reclassification Cascade Delete
 * -------------------------------------------------------------------------
 * When a source transaction (Vendor Bill, Vendor Credit, Credit Memo,
 * Invoice, Journal Entry, or Advanced Intercompany Journal Entry) that has
 * one or more Interco reclassification JEs linked to it via
 * custbody_linked_allocation_transaction is deleted, this script deletes
 * those linked Interco JEs as well - so the automation never leaves an
 * orphaned reclassification entry behind after its source is removed.
 *
 * Deploy this SAME script file against each of the source record types
 * listed above (a separate Deployment record per type, all pointing at
 * this script) - a single deployment only applies to one record type.
 *
 * As a defensive design note: this script does NOT attempt to re-verify
 * the JE's own custbody_vsr_ints_source_tran_interco field before
 * deleting, because NetSuite automatically nulls out List/Record:
 * Transaction fields that reference a record once that record is deleted
 * - so that field is already cleared by the platform itself by the time
 * this script runs. The source transaction's own
 * custbody_linked_allocation_transaction value (captured before deletion)
 * is the reliable source of truth instead.
 * ---------------------------------------------------------------------
 */
define(['N/record', 'N/log'], (record, log) => {

    // Fixed script ID - same convention as the Map/Reduce script.
    const SOURCE_LINK_FIELD = 'custbody_linked_allocation_transaction';

    const afterSubmit = (context) => {
        if (context.type !== context.UserEventType.DELETE) {
            return;
        }

        const oldRecord = context.oldRecord;
        if (!oldRecord) {
            return;
        }

        const sourceInternalId = String(oldRecord.id);
        let linkedJeIds = [];
        try {
            linkedJeIds = oldRecord.getValue({ fieldId: SOURCE_LINK_FIELD }) || [];
        } catch (e) {
            // Field may not exist on this record type's form - nothing to
            // cascade in that case.
            log.debug(
                'afterSubmit - no link field',
                'Source ' + sourceInternalId + ' has no ' + SOURCE_LINK_FIELD + ' value: ' + e.message
            );
            return;
        }

        if (!linkedJeIds.length) {
            return;
        }

        log.audit(
            'afterSubmit - cascade delete start',
            'Source transaction ' + sourceInternalId + ' deleted. Linked Interco JE(s) to remove: ' +
            linkedJeIds.join(', ')
        );

        linkedJeIds.forEach((jeId) => {
            try {
                // NOTE: we intentionally do NOT re-check the JE's own
                // custbody_vsr_ints_source_tran_interco field here.
                // NetSuite automatically nulls out List/Record: Transaction
                // fields that point to a record once that record is
                // deleted - so by the time this afterSubmit runs, the JE's
                // back-reference to this source has already been cleared
                // by the platform itself, before we ever get to read it.
                // The source's own multi-select field (captured above from
                // oldRecord, before deletion) is the reliable source of
                // truth here instead.
                record.delete({ type: record.Type.JOURNAL_ENTRY, id: jeId });

                log.audit(
                    'afterSubmit - JE deleted',
                    'Deleted Interco JE ' + jeId + ' (source transaction ' + sourceInternalId + ' was deleted).'
                );

            } catch (e) {
                // Common causes: JE already deleted manually, posting
                // period is closed/locked, or the JE is otherwise
                // restricted from deletion - log and continue with the
                // remaining linked JEs rather than stopping entirely.
                log.error(
                    'afterSubmit - JE delete failed',
                    'Failed to delete Interco JE ' + jeId + ' for source ' + sourceInternalId +
                    ': ' + e.message + '. Manual cleanup may be required.'
                );
            }
        });
    };

    return { afterSubmit };
});