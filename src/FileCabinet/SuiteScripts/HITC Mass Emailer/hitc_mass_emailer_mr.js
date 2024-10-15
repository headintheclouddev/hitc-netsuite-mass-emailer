/**
 * hitc_mass_emailer_mr.ts
 * by Head in the Cloud Development, Inc.
 * gurus@headintheclouddev.com
 *
 * @NScriptName HITC Mass Emailer - Map Reduce
 * @NScriptType MapReduceScript
 * @NApiVersion 2.1
 */
define(["require", "exports", "N/email", "N/log", "N/record", "N/render", "N/runtime", "N/search", "N/task", "N/url"], function (require, exports, email, log, record, render, runtime, search, task, url) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.summarize = exports.reduce = exports.map = void 0;
    exports.getInputData = getInputData;
    /** Find HITC Mass Email Task records to process. */
    function getInputData() {
        // Find records where the status is "Not Started"
        const recordsToProcess = [];
        const batchSize = runtime.getCurrentScript().getParameter({ name: 'custscript_hitc_mass_emailer_batch_size' });
        search.create({ type: 'customrecord_hitc_mass_email_task', filters: [['custrecord_hitc_mass_email_task_status', 'anyof', '1']] }).run().each((result) => {
            // Mark the record as in progress
            record.submitFields({ type: result.recordType.toString(), id: result.id, values: { custrecord_hitc_mass_email_task_status: '2' } });
            // Load the record and process it
            const rec = record.load({ type: result.recordType.toString(), id: Number(result.id) });
            const data = JSON.parse(rec.getValue('custrecord_hitc_mass_email_task_data'));
            // Add recipients from sublists
            for (let i = 0; i < data.recipients.length; i++) {
                recordsToProcess.push({ taskRecId: result.id, recipient: data.recipients[i], campaignId: data.campaignId });
            }
            // Load recipients from saved search if they weren't in the sublist
            if (data.savedSearch && data.populateList != 'T') {
                log.audit('getInputData', `Loading saved search ${data.savedSearch} for task ${result.id}.`);
                let columnName = '', join = '';
                if (data.searchField) {
                    columnName = ~data.searchField.indexOf('.') ? data.searchField.substring(data.searchField.indexOf('.') + 1) : data.searchField;
                    if (~data.searchField.indexOf('.'))
                        join = data.searchField.substring(0, data.searchField.indexOf('.'));
                }
                const surplusRecipients = [];
                getAllResults(search.load({ id: data.savedSearch })).forEach((entityResult) => {
                    let entityId = entityResult.id; // Unless we've specified a different search column
                    if (columnName) {
                        entityResult.columns.forEach((column) => {
                            if (column.name == columnName && (!join || join == column.join))
                                entityId = entityResult.getValue(column);
                        });
                    }
                    if (!batchSize || recordsToProcess.length < batchSize) {
                        recordsToProcess.push({ taskRecId: result.id, recipient: { type: data.searchType, id: entityId }, campaignId: data.campaignId });
                    }
                    else {
                        surplusRecipients.push({ type: data.searchType, id: entityId });
                    }
                });
                if (batchSize)
                    createTasksForSurplusRecipients(surplusRecipients, data);
            }
            log.audit(`Processing record ${result.id}`, `Emails to send: ${recordsToProcess.length}`);
            return false; // Only process one record at a time. Re-queue at the end if there are more.
        });
        return recordsToProcess;
    }
    /** Merge the template and send the email. */
    const map = (context) => {
        log.debug(`map ${context.key}`, context.value);
        try {
            const contextValues = JSON.parse(context.value);
            if (isUnsubscribed(contextValues.recipient, contextValues.campaignId))
                return context.write(contextValues.taskRecId, 'Processed');
            if (hasRecentBounce(contextValues.recipient, contextValues.campaignId))
                return context.write(contextValues.taskRecId, 'Skipped Bounce');
            // Load the record and get the body text
            const rec = record.load({ type: 'customrecord_hitc_mass_email_task', id: Number(contextValues.taskRecId) });
            const data = JSON.parse(rec.getValue('custrecord_hitc_mass_email_task_data'));
            let body = data.body;
            let subject = data.subject;
            const relatedRecords = {};
            const attachments = [];
            if (data.transaction) {
                attachments.push(render.transaction({ entityId: Number(data.transaction), printMode: data.printMode }));
                relatedRecords['transactionId'] = data.transaction;
            }
            if (data.template) {
                try {
                    const merge = render.mergeEmail({ templateId: Number(data.template), entity: { type: contextValues.recipient.type, id: Number(contextValues.recipient.id) } });
                    body = merge.body;
                    subject = merge.subject;
                }
                catch (e) {
                    return log.error(`Failed to load template ${data.template}`, e.message);
                }
            }
            if (contextValues.campaignId)
                body = body.replace('{{UNSUBSCRIBE}}', getUnsubscribeURL(contextValues));
            try {
                email.send({ author: Number(data.author), recipients: [Number(contextValues.recipient.id)], subject, body, cc: data.cc, bcc: data.bcc, relatedRecords, attachments });
                log.debug(`map ${context.key}`, `Email Sent to Recipient: ${contextValues.recipient.type} ${contextValues.recipient.id} at ${new Date()}`);
                context.write(contextValues.taskRecId, 'Processed');
            }
            catch (e) {
                log.error(`map ${context.key}`, `Email Failed; Recipient: ${contextValues.recipient.type} ${contextValues.recipient.id}; ${e.message}`);
                context.write(contextValues.taskRecId, 'Error');
            }
        }
        catch (e) {
            log.error(`map ${context.key}`, e.message);
        }
    };
    exports.map = map;
    const reduce = (context) => {
        log.audit('reduce', `Key ${context.key} values ${context.values.length}`);
        try {
            let emailsSent = 0, errors = 0;
            context.values.forEach((mapResult) => {
                if (mapResult == 'Processed')
                    emailsSent++;
                else
                    errors++;
            });
            log.audit('reduce', `Updating record ${context.key} with emails sent ${emailsSent}, errors ${errors}.`);
            record.submitFields({
                type: 'customrecord_hitc_mass_email_task',
                id: context.key,
                values: { custrecord_hitc_mass_email_task_status: '3', custrecord_hitc_mass_email_task_sent: emailsSent }
            });
        }
        catch (e) {
            log.error('reduce', `Key ${context.key}: ${e.message}`);
        }
    };
    exports.reduce = reduce;
    /** Record the results onto the HITC Mass Email Task record */
    const summarize = (context) => {
        log.audit('Summarize Context', JSON.stringify(context));
        search.create({ type: 'customrecord_hitc_mass_email_task', filters: [['custrecord_hitc_mass_email_task_status', 'anyof', '1']] }).run().each((result) => {
            log.audit('Summarize Context', `Re-queuing for record ${result.id}`);
            try {
                task.create({ scriptId: 'customscript_hitc_mass_emailer_mr', taskType: task.TaskType.MAP_REDUCE }).submit();
            }
            catch (e) {
                log.error('summarize', `Failed to queue: ${e.message}`);
            }
            return false;
        });
        // context.reduceSummary.keys.iterator().each((key) => {
        //   log.debug('Summarize - Updating Record', key);
        //   try {
        //     record.submitFields({
        //       type:   'customrecord_hitc_mass_email_task',
        //       id:     key,
        //       values: { custrecord_hitc_mass_email_task_status: '3' }
        //     });
        //   } catch(e) {
        //     log.error('Record Update Failed', e.message);
        //   }
        //   return true;
        // });
        log.audit('Execution Complete', 'Exiting');
    };
    exports.summarize = summarize;
    function createTasksForSurplusRecipients(surplusRecipients, data) {
        const batchSize = runtime.getCurrentScript().getParameter({ name: 'custscript_hitc_mass_emailer_batch_size' });
        data.savedSearch = '';
        surplusRecipients.forEach((recipient, idx) => {
            if (idx % batchSize == 0) { // 50k is NetSuite spam max
                if (idx) {
                    const rec = record.create({ type: 'customrecord_hitc_mass_email_task' });
                    rec.setValue('custrecord_hitc_mass_email_task_data', JSON.stringify(data));
                    const recId = String(rec.save());
                    log.debug('createTasksForSurplusRecipients', `Email Task Record Created: ${recId} with recipients ${data.recipients.length}.`);
                }
                data.recipients = [];
            }
            data.recipients.push(recipient);
        });
        if (data.recipients.length > 0) {
            const rec = record.create({ type: 'customrecord_hitc_mass_email_task' });
            rec.setValue('custrecord_hitc_mass_email_task_data', JSON.stringify(data));
            const recId = String(rec.save());
            log.debug('createTasksForSurplusRecipients', `Email Task Record Created: ${recId} with recipients ${data.recipients.length}.`);
        }
    }
    function getUnsubscribeURL(values) {
        const eid = Number(values.recipient.id) * 7777; // Super secure encryption!
        const etype = values.recipient.type;
        const cid = values.campaignId;
        return url.resolveScript({
            scriptId: 'customscript_hitc_mass_emailer_unsub_sl',
            deploymentId: 'customdeploy1',
            returnExternalUrl: true,
            params: { cid, eid, etype }
        });
    }
    function hasRecentBounce(recipient, campaignId) {
        const values = search.lookupFields({ type: recipient.type, id: recipient.id, columns: ['entityid', 'email'] });
        const results = search.create({
            type: 'sentemail',
            filters: [['torecipients', 'contains', values.email], 'and', ['sentdate', 'after', 'thirtydaysago'], 'and', ['reasonstring', 'isnotempty', '']]
        }).run().getRange({ start: 0, end: 1000 });
        log.debug('hasRecentBounce', `Bounces for ${JSON.stringify(recipient)} (${JSON.stringify(values)}): ${results.length} at ${new Date()}`);
        if (campaignId && results.length > 0) { // Load the record and unsubscribe them
            log.debug('hasRecentBounce', `Loading ${JSON.stringify(recipient)} to unsubscribe from campaign ${campaignId}.`);
            const rec = record.load({ type: recipient.type, id: recipient.id });
            const line = rec.findSublistLineWithValue({ sublistId: 'subscriptions', fieldId: 'subscription', value: campaignId });
            if (~line && rec.getSublistValue({ sublistId: 'subscriptions', fieldId: 'subscribed', line })) {
                rec.setSublistValue({ sublistId: 'subscriptions', fieldId: 'subscribed', line: line, value: false });
                rec.save();
            }
        }
        return results.length > 0;
    }
    function isUnsubscribed(recipient, campaignId) {
        let isUnsubscribed = false;
        if (campaignId) {
            search.create({
                type: recipient.type,
                filters: [['internalid', 'anyof', recipient.id], 'and', ['subscription', 'anyof', campaignId]],
                columns: ['subscriptionstatus']
            }).run().each((result) => {
                const subscribed = result.getValue('subscriptionstatus');
                log.debug('Subscription status', `${recipient.type} ${recipient.id}, campaign ${campaignId}, subscribed: ${subscribed}.`);
                isUnsubscribed = !subscribed;
                return false;
            });
        }
        return isUnsubscribed;
    }
    function getAllResults(searchObj) {
        const pageData = searchObj.runPaged({ pageSize: 1000 });
        let results = [];
        for (const pageRange of pageData.pageRanges) {
            log.debug('getAllResults', `Fetching index ${pageRange.index}, results ${results.length} at ${new Date()}.`);
            const page = pageData.fetch({ index: pageRange.index });
            results = results.concat(page.data);
        }
        return results;
    }
});
