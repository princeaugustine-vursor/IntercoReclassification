/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * VSR - Interco Reclassification Automation
 * -------------------------------------------------------------------------
 * Covers TDD Use Cases #1, #2, #3.1, #3.2 (single-subsidiary Bills / Journal
 * Entries) and #3.3 (advanced intercompany Journal Entries spanning more
 * than one subsidiary).
 *
 * Every environment-specific value (saved search ID, field IDs, IC account,
 * Corp property mapping) is a script parameter on the deployment - nothing
 * below is hardcoded, so this can be promoted across accounts/environments
 * without a code change.
 *
 * ---------------------------------------------------------------------
 * SCRIPT PARAMETERS - create these on the script record:
 * ---------------------------------------------------------------------
 *  custscript_vsr_saved_search_id     Free-Form Text  (required)
 *      Internal ID/script ID of the eligible-transaction saved search.
 *      Default used if blank: customsearch_vsr_ints_interco_trans
 *
 *  custscript_vsr_ic_account          List/Record: Account  (required)
 *      The "ISM Property Interco (IC)" account used on both sides of
 *      every generated Interco JE line.
 *
 *  custscript_vsr_corp_property_map   Long Text (JSON)  (optional)
 *      Subsidiary internal ID -> Corp property internal ID, e.g.
 *      {"6":"201","3":"203","2":"206"}
 *      Default used if blank: {"6":"201","3":"203","2":"206"}
 *
 * The following are fixed script IDs (not environment-specific internal
 * IDs), so they are hardcoded below rather than exposed as parameters -
 * script IDs stay identical across sandbox/production once migrated via
 * bundle/SDF:
 *    - Source transaction link field:  custbody_linked_allocation_transaction
 *    - Interco JE source field:        custbody_vsr_ints_source_tran_interco
 *    - Property segment field (JE line): cseg_vsr_intn_prpty
 * ---------------------------------------------------------------------
 */
define(['N/search', 'N/record', 'N/log', 'N/runtime', 'N/error'], (search, record, log, runtime, error) => {

    // Fixed script IDs - identical across environments, so hardcoded
    // rather than exposed as script parameters.
    const SOURCE_LINK_FIELD = 'custbody_linked_allocation_transaction';
    const JE_SOURCE_FIELD = 'custbody_vsr_ints_source_tran_interco';
    const PROPERTY_SEGMENT_FIELD_ID = 'cseg_vsr_intn_prpty';


    // Maps NetSuite's internal transaction type code (as returned by the
    // "type" search column) to the record.Type needed to load/submit it.
    // This is a fixed NetSuite mapping, not an environment-specific
    // setting, so it is not exposed as a script parameter.
    //
    // IMPORTANT: this must stay a function, not a module-level object
    // literal. Building the object at the top of define() evaluates
    // record.Type.* while the module is still loading, before any entry
    // point has run - NetSuite blocks all SuiteScript API access at that
    // point and throws SUITESCRIPT_API_UNAVAILABLE_IN_DEFINE. Wrapping it
    // in a function defers that access until an entry point calls it.
    function getRecordTypeForSearchType(searchType) {
        const map = {
            'VendBill': record.Type.VENDOR_BILL,
            'VendCred': record.Type.VENDOR_CREDIT,
            'CustCred': record.Type.CREDIT_MEMO,
            'CustInvc': record.Type.INVOICE,
            'Journal': record.Type.JOURNAL_ENTRY
        };
        return map[searchType];
    }

    let cachedConfig = null;

    // ---------------------------------------------------------------
    // Config / script parameters
    // ---------------------------------------------------------------
    function getConfig() {
        if (cachedConfig) return cachedConfig;

        const scriptObj = runtime.getCurrentScript();

        const param = (name, fallback) => {
            const value = scriptObj.getParameter({ name: name });
            return (value === null || value === undefined || value === '') ? fallback : value;
        };

        const icAccountId = param('custscript_vsr_ic_account', null);
        if (!icAccountId) {
            throw error.create({
                name: 'MISSING_PARAMETER',
                message: 'Script parameter custscript_vsr_ic_account is required and is not set.'
            });
        }

        const corpPropertyMapRaw = param(
            'custscript_vsr_corp_property_map',
            '{"6":"201","3":"203","2":"206"}'
        );
        let corpPropertyMap;
        try {
            corpPropertyMap = JSON.parse(corpPropertyMapRaw);
        } catch (e) {
            throw error.create({
                name: 'INVALID_PARAMETER',
                message: 'custscript_vsr_corp_property_map is not valid JSON: ' + corpPropertyMapRaw
            });
        }

        cachedConfig = {
            savedSearchId: param('custscript_vsr_saved_search_id', 'customsearch_vsr_ints_interco_trans'),
            icAccountId: icAccountId,
            corpPropertyMap: corpPropertyMap,
            systemFlagField: param('custscript_vsr_system_flag_field', null)
        };

        return cachedConfig;
    }

    // ---------------------------------------------------------------
    // Search result column helpers
    // ---------------------------------------------------------------

    // Search results serialized through getInputData -> map() come back as
    // a JSON string. Column values can appear as a plain value, an
    // {value, text} object, or an array of {value, text} (join/multi-select
    // style) depending on the field type - normalize all of them here.
    function extractColumn(values, key) {
        const raw = values[key];
        if (raw === null || raw === undefined || raw === '') {
            return { value: '', text: '' };
        }
        if (Array.isArray(raw)) {
            if (raw.length === 0) return { value: '', text: '' };
            return { value: raw[0].value, text: raw[0].text };
        }
        if (typeof raw === 'object') {
            return { value: raw.value, text: raw.text };
        }
        return { value: raw, text: raw };
    }

    function toAmount(raw) {
        const n = parseFloat(raw);
        return isNaN(n) ? 0 : n;
    }

    function round2(n) {
        return Math.round((n + Number.EPSILON) * 100) / 100;
    }

    // =================================================================
    // GET INPUT DATA
    // =================================================================
    const getInputData = () => {
        const config = getConfig();
        log.debug('getInputData', 'Loading saved search ' + config.savedSearchId);
        return search.load({ id: config.savedSearchId });
    };

    // =================================================================
    // MAP - re-key every search result row by its source transaction's
    // internal ID, so all lines of one transaction land on the same
    // reduce() call together.
    // =================================================================
    const map = (context) => {
        const result = JSON.parse(context.value);
        const values = result.values;

        const internalId = extractColumn(values, 'internalid').value;
        const docNumber = extractColumn(values, 'tranid').value;
        const typeCol = extractColumn(values, 'type');
        const subsidiaryCol = extractColumn(values, 'subsidiarynohierarchy');
        const propertyCol = extractColumn(values, 'line.cseg_vsr_intn_prpty');
        const memo = extractColumn(values, 'memomain').value;

        if (!internalId) {
            log.error('map - skipped row', 'No internal ID found on result: ' + context.value);
            return;
        }

        const lineData = {
            internalId: internalId,
            docNumber: docNumber,
            typeId: typeCol.value,
            typeText: typeCol.text,
            subsidiaryId: subsidiaryCol.value,
            subsidiaryText: subsidiaryCol.text,
            memo: memo,
            propertyId: propertyCol.value,
            propertyText: propertyCol.text,
            debit: toAmount(values.debitamount),
            credit: toAmount(values.creditamount)
        };

        context.write({
            key: internalId,
            value: JSON.stringify(lineData)
        });
    };

    // =================================================================
    // REDUCE - one call per source transaction. context.values is every
    // line collected for that transaction across all map() calls.
    // =================================================================
    const reduce = (context) => {
        const sourceInternalId = context.key;
        const lines = context.values.map((v) => JSON.parse(v));

        if (lines.length === 0) return;

        const first = lines[0];
        const config = getConfig();
        let jeIds = [];

        try {
            const subsidiaryGroups = groupBySubsidiary(lines);
            const subsidiaryIds = Object.keys(subsidiaryGroups);

            if (subsidiaryIds.length === 1) {
                // ---- Single-subsidiary transaction: Use Cases #1, #2,
                // #3.1, #3.2. Mirror every line 1:1 into ONE Interco JE.
                const subsidiaryId = subsidiaryIds[0];
                const mirroredLines = lines.map(mirrorLine);
                const jeId = createIntercoJE(config, {
                    subsidiaryId: subsidiaryId,
                    lines: mirroredLines,
                    sourceInternalId: sourceInternalId,
                    docNumber: first.docNumber,
                    memo: first.memo
                });
                jeIds.push(jeId);

            } else {
                // ---- Multi-subsidiary transaction: Use Case #3.3
                // (advanced intercompany JE). Generate one JE per
                // subsidiary, with a freshly computed Corp line sized to
                // that subsidiary's own property-line total - NOT a
                // straight mirror of the original combined Corp line.
                subsidiaryIds.forEach((subsidiaryId) => {
                    const corpPropertyId = config.corpPropertyMap[subsidiaryId];
                    if (!corpPropertyId) {
                        throw error.create({
                            name: 'MISSING_CORP_PROPERTY_MAPPING',
                            message: 'No Corp property mapped for subsidiary ' + subsidiaryId
                        });
                    }

                    const groupLines = subsidiaryGroups[subsidiaryId];
                    // Exclude any line that IS this subsidiary's own Corp
                    // property - it will be recomputed below, not mirrored
                    // directly, since its source amount may represent a
                    // combined total across subsidiaries.
                    const propertyLines = groupLines.filter(
                        (l) => l.propertyId !== corpPropertyId
                    );

                    const mirroredLines = propertyLines.map(mirrorLine);

                    let addedDebit = 0;
                    let addedCredit = 0;
                    mirroredLines.forEach((m) => {
                        addedDebit += m.debit;
                        addedCredit += m.credit;
                    });

                    const diff = round2(addedCredit - addedDebit);
                    const corpLine = diff > 0
                        ? { propertyId: corpPropertyId, debit: diff, credit: 0 }
                        : { propertyId: corpPropertyId, debit: 0, credit: round2(-diff) };

                    const jeId = createIntercoJE(config, {
                        subsidiaryId: subsidiaryId,
                        lines: mirroredLines.concat([corpLine]),
                        sourceInternalId: sourceInternalId,
                        docNumber: first.docNumber,
                        memo: first.memo
                    });
                    jeIds.push(jeId);
                });
            }

            // Only after every required JE for this source transaction has
            // been created successfully do we write back the multi-select
            // link field - this keeps "field is empty" a reliable signal
            // that the source still needs processing.
            //
            // A source with more than one subsidiary group is, by
            // definition, an Advanced Intercompany Journal Entry - NetSuite
            // stores these under a distinct record type
            // (advintercompanyjournalentry) even though transaction
            // searches label them the same as a regular Journal Entry, so
            // we can't rely on the search's "type" column here.
            const isAdvancedIntercompany = subsidiaryIds.length > 1;
            updateSourceTransaction(config, sourceInternalId, first.typeId, jeIds, isAdvancedIntercompany);

            log.audit(
                'reduce - success',
                'Source ' + first.typeText + ' ' + first.docNumber +
                ' (' + sourceInternalId + ') -> Interco JE(s): ' + jeIds.join(', ')
            );

        } catch (e) {
            log.error(
                'reduce - failed',
                'Source transaction ' + sourceInternalId + ' (' + (first.docNumber || '') +
                ') failed: ' + e.message +
                (jeIds && jeIds.length
                    ? ' | WARNING: Interco JE(s) already created before failure, ' +
                      'not yet linked back to source - check for orphans: ' + jeIds.join(', ')
                    : '')
            );
            // Intentionally do NOT update the source's link field here, so
            // this transaction is retried on the next scheduled run. Note
            // that if the failure happened after JE creation (e.g. during
            // the write-back above), any JE IDs logged in the warning
            // above already exist and will be duplicated on retry unless
            // removed manually first.
        }
    };

    // =================================================================
    // SUMMARIZE
    // =================================================================
    const summarize = (summary) => {
        let errorCount = 0;
        summary.mapSummary.errors.iterator().each((key, err) => {
            errorCount++;
            log.error('Map error', 'Key: ' + key + ' Error: ' + err);
            return true;
        });
        summary.reduceSummary.errors.iterator().each((key, err) => {
            errorCount++;
            log.error('Reduce error', 'Key: ' + key + ' Error: ' + err);
            return true;
        });
        log.audit(
            'summarize',
            'Interco reclassification run complete. Errors: ' + errorCount +
            '. Usage (map): ' + summary.mapSummary.usage +
            '. Usage (reduce): ' + summary.reduceSummary.usage
        );
    };

    // =================================================================
    // Helpers
    // =================================================================

    function groupBySubsidiary(lines) {
        const groups = {};
        lines.forEach((line) => {
            if (!groups[line.subsidiaryId]) {
                groups[line.subsidiaryId] = [];
            }
            groups[line.subsidiaryId].push(line);
        });
        return groups;
    }

    // Flip whichever side the line actually landed on in the source
    // transaction - do NOT hardcode which side Property/Corp "always" use.
    // This keeps Vendor Credits / Credit Memos safe once those directions
    // are confirmed.
    function mirrorLine(line) {
        return {
            propertyId: line.propertyId,
            debit: round2(line.credit),
            credit: round2(line.debit)
        };
    }

    function createIntercoJE(config, params) {
        const je = record.create({
            type: record.Type.JOURNAL_ENTRY,
            isDynamic: true
        });

        je.setValue({ fieldId: 'subsidiary', value: params.subsidiaryId });
        je.setValue({
            fieldId: 'memo',
            value: 'Interco Reclassification - Source: ' + params.docNumber
        });
        je.setValue({ fieldId: JE_SOURCE_FIELD, value: params.sourceInternalId });

        if (config.systemFlagField) {
            je.setValue({ fieldId: config.systemFlagField, value: true });
        }

        params.lines.forEach((line) => {
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'account',
                value: config.icAccountId
            });
            if (line.debit) {
                je.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'debit',
                    value: line.debit
                });
            }
            if (line.credit) {
                je.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'credit',
                    value: line.credit
                });
            }
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: PROPERTY_SEGMENT_FIELD_ID,
                value: line.propertyId
            });
            je.commitLine({ sublistId: 'line' });
        });

        return je.save();
    }

    function updateSourceTransaction(config, sourceInternalId, sourceTypeId, jeIds, isAdvancedIntercompany) {
        // Advanced Intercompany Journal Entries live under their own
        // record type in NetSuite (advintercompanyjournalentry), distinct
        // from a regular Journal Entry, even though transaction searches
        // label both with the same "Journal" type. Any source with more
        // than one subsidiary group is, by definition, one of these, so
        // we override the record type here rather than trusting the
        // search's type column.
        const sourceRecordType = isAdvancedIntercompany
            ? 'advintercompanyjournalentry'
            : getRecordTypeForSearchType(sourceTypeId);

        if (!sourceRecordType) {
            throw error.create({
                name: 'UNKNOWN_SOURCE_TYPE',
                message: 'No record.Type mapping for search type: ' + sourceTypeId
            });
        }

        record.submitFields({
            type: sourceRecordType,
            id: sourceInternalId,
            values: {
                [SOURCE_LINK_FIELD]: jeIds
            },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    }

    return { getInputData, map, reduce, summarize };
});