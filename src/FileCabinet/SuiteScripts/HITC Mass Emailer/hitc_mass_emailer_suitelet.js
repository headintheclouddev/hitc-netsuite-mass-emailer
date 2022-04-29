/**
 * hitc_mass_emailer_suitelet.ts
 * by Head in the Cloud Development, Inc.
 * gurus@headintheclouddev.com
 *
 * @NScriptName HITC Mass Emailer Suitelet
 * @NScriptType Suitelet
 * @NApiVersion 2.1
 */
define(["require", "exports", "N/email", "N/error", "N/https", "N/log", "N/ui/message", "N/record", "N/render", "N/runtime", "N/search", "N/ui/serverWidget", "N/task"], function (require, exports, email, error, https, log, message, record, render, runtime, search, serverWidget, task) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.onRequest = void 0;
    function onRequest(context) {
        if (context.request.method == 'GET') {
            try {
                context.response.writePage({ pageObject: drawForm(0) });
            }
            catch (e) {
                throw error.create({ name: e.name, message: e.message, notifyOff: true });
            }
        }
        else { // User submitted the form
            const attachments = [];
            const relatedRecords = {};
            const bcc = getCCLines(context.request, 'bcc');
            const cc = getCCLines(context.request, 'cc');
            const inputs = context.request.parameters;
            const doScheduled = runtime.getCurrentScript().getParameter({ name: 'custscript_hitc_mass_emailer_send_async' });
            let emailsSent = 0;
            log.debug('POST', `Inputs: ${JSON.stringify(inputs)}.`);
            if (inputs.custpage_transaction) {
                const pdf = render.transaction({ entityId: Number(inputs.custpage_transaction), printMode: inputs.custpage_print_mode });
                attachments.push(pdf);
                relatedRecords.transactionId = Number(inputs.custpage_transaction);
            }
            if (doScheduled) {
                const recId = queueMapReduceScript(inputs, cc, bcc, context.request);
                context.response.sendRedirect({ type: https.RedirectType.RECORD, identifier: 'customrecord_hitc_mass_email_task', id: recId });
            }
            else if (inputs.custpage_saved_search && inputs.custpage_populate_list == 'F') { // If the list is populated, it overrides the actual contents of the saved search.
                log.debug('POST', `Loading search ${inputs.custpage_saved_search} to send synchronously.`);
                search.load({ id: inputs.custpage_saved_search }).run().each((result) => {
                    const recipient = getRecipientFromResult(result, inputs.custpage_search_field);
                    const sentEmail = mergeAndSendEmail(cc, bcc, relatedRecords, attachments, inputs.custpage_search_type, recipient, inputs);
                    if (sentEmail)
                        emailsSent++;
                    return true;
                });
            }
            else { // Go through and send email to the "To" recipients
                ['contact', 'customer', 'employee', 'partner'].forEach((entityType) => {
                    for (let line = 0; line < context.request.getLineCount({ group: `custpage_${entityType}s` }); line++) {
                        const recipient = context.request.getSublistValue({ group: `custpage_${entityType}s`, name: `custpage_${entityType}_${entityType}`, line });
                        const toLine = context.request.getSublistValue({ group: `custpage_${entityType}s`, name: `custpage_${entityType}_to`, line });
                        if (toLine) {
                            const sentEmail = mergeAndSendEmail(cc, bcc, relatedRecords, attachments, entityType, recipient, inputs);
                            if (sentEmail)
                                emailsSent++;
                        }
                    }
                });
            }
            context.response.writePage({ pageObject: drawForm(emailsSent) });
        }
    }
    exports.onRequest = onRequest;
    function drawForm(emailsSent) {
        const form = serverWidget.createForm({ title: 'Mass Emailer' });
        if (emailsSent)
            form.addPageInitMessage({ type: message.Type.CONFIRMATION, title: 'Success', message: `Sent ${emailsSent} emails.` });
        // Add field groups
        form.addFieldGroup({ id: 'compose', label: 'Compose Email' }).isSingleColumn = true;
        form.addFieldGroup({ id: 'tran_group', label: 'Attach Transaction' }).isSingleColumn = true;
        form.addFieldGroup({ id: 'search_group', label: 'Fill from Saved Search' }).isSingleColumn = true;
        // Add Header fields
        const authorField = form.addField({ id: 'custpage_author', type: serverWidget.FieldType.SELECT, label: 'Author', source: 'employee', container: 'compose' });
        authorField.setHelpText({ help: 'Author of the emails' });
        authorField.isMandatory = true;
        authorField.defaultValue = String(runtime.getCurrentUser().id);
        form.addField({ id: 'custpage_template', type: serverWidget.FieldType.SELECT, label: 'Email Template', source: 'emailtemplate', container: 'compose' })
            .setHelpText({ help: 'Select an email template.' });
        form.addField({ id: 'custpage_subject', type: serverWidget.FieldType.TEXT, label: 'Email Subject', container: 'compose' })
            .setHelpText({ help: 'Subject for the emails' });
        form.addField({ id: 'custpage_body', type: serverWidget.FieldType.RICHTEXT, label: 'Email Body', container: 'compose' })
            .setHelpText({ help: 'Email body preview' });
        form.addField({ id: 'custpage_transaction', type: serverWidget.FieldType.SELECT, label: 'Attach Transaction', source: 'transaction', container: 'tran_group' })
            .setHelpText({ help: 'Select a transaction to attach as a printout.' });
        form.addField({ id: 'custpage_saved_search', type: serverWidget.FieldType.SELECT, label: 'Saved Search', source: '-119', container: 'search_group' })
            .setHelpText({ help: 'Select a public saved search to auto-fill recipients from' });
        const searchTypeField = form.addField({ id: 'custpage_search_type', label: 'Result Type', type: serverWidget.FieldType.SELECT, container: 'search_group' });
        form.addField({ id: 'custpage_search_field', type: serverWidget.FieldType.TEXT, label: 'Search Column', container: 'search_group' })
            .setHelpText({ help: 'For example, if you are doing a customer search but need the email to go to related contacts, you may enter contact.internalid' });
        form.addField({ id: 'custpage_populate_list', type: serverWidget.FieldType.CHECKBOX, label: 'Populate List', container: 'search_group' })
            .setHelpText({ help: 'If checked, the results from the search you select will auto-fill into the sublists below. To avoid performance issues, leave this unchecked for searches with more than about 100 results.' });
        form.addField({ id: 'custpage_subscription', type: serverWidget.FieldType.SELECT, label: 'Subscription', container: 'search_group', source: 'campaignsubscription' })
            .setHelpText({ help: 'If a subscription is selected then an unsubscribe link can be added to the bottom of the email. You must have a {{UNSUBSCRIBE}} tag in your email template for the unsubscribe link to be inserted. Also, recipients who are unsubscribed will not have an email sent to them.' });
        form.addField({ id: 'custpage_print_mode_label', type: serverWidget.FieldType.LABEL, label: 'Print Mode:', container: 'tran_group' })
            .setHelpText({ help: 'Choose the method by which to attach the transaction.' })
            .defaultValue = 'PDF';
        form.addField({ id: 'custpage_print_mode', type: serverWidget.FieldType.RADIO, label: 'PDF', source: 'PDF', container: 'tran_group' });
        form.addField({ id: 'custpage_print_mode', type: serverWidget.FieldType.RADIO, label: 'HTML', source: 'HTML', container: 'tran_group' });
        form.addField({ id: 'custpage_print_mode', type: serverWidget.FieldType.RADIO, label: 'Customer Default', source: 'DEFAULT', container: 'tran_group' });
        // Populate the Search Type dropdown
        searchTypeField.addSelectOption({ value: '', text: '' });
        searchTypeField.addSelectOption({ value: 'contact', text: 'Contact' });
        searchTypeField.addSelectOption({ value: 'employee', text: 'Employee' });
        searchTypeField.addSelectOption({ value: 'partner', text: 'Partner' });
        searchTypeField.addSelectOption({ value: 'customer', text: 'Lead / Customer' });
        searchTypeField.addSelectOption({ value: 'vendor', text: 'Vendor' });
        searchTypeField.setHelpText({ help: 'Select the record type that this saved search applies to. If you are using an email template, this is required.' });
        // Recipients tabs
        form.addTab({ id: 'custpage_contact_tab', label: 'Contacts' });
        form.addTab({ id: 'custpage_employee_tab', label: 'Employees' });
        form.addTab({ id: 'custpage_partner_tab', label: 'Partners' });
        form.addTab({ id: 'custpage_customer_tab', label: 'Leads / Customers' });
        // Create sublists
        ['Contact', 'Employee', 'Partner', 'Customer'].forEach((entityTypeLabel) => {
            const entityType = entityTypeLabel.toLowerCase();
            const sublist = form.addSublist({ id: `custpage_${entityType}s`, label: `${entityTypeLabel}s`, tab: `custpage_${entityType}_tab`, type: serverWidget.SublistType.INLINEEDITOR });
            sublist.addField({ id: `custpage_${entityType}_${entityType}`, type: serverWidget.FieldType.SELECT, label: entityType, source: entityType }).isMandatory = true;
            if (entityType == 'contact')
                sublist.addField({ id: 'custpage_contact_company', type: serverWidget.FieldType.TEXT, label: 'Company' })
                    .updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            sublist.addField({ id: `custpage_${entityType}_email`, type: serverWidget.FieldType.EMAIL, label: 'Email' })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED })
                .isMandatory = true;
            sublist.addField({ id: `custpage_${entityType}_to`, type: serverWidget.FieldType.CHECKBOX, label: 'To' }).defaultValue = 'T';
            sublist.addField({ id: `custpage_${entityType}_cc`, type: serverWidget.FieldType.CHECKBOX, label: 'CC' });
            sublist.addField({ id: `custpage_${entityType}_bcc`, type: serverWidget.FieldType.CHECKBOX, label: 'BCC' });
        });
        form.addSubmitButton({ label: 'Send' });
        form.clientScriptModulePath = './hitc_mass_emailer_client';
        return form;
    }
    function getCCLines(req, ccOrBcc) {
        const emails = [];
        ['contact', 'employee', 'partner', 'customer'].forEach((entityType) => {
            const group = `custpage_${entityType}s`;
            for (let line = 0; line < req.getLineCount({ group }); line++) {
                const emailAddress = req.getSublistValue({ group, name: `custpage_${entityType}_email`, line });
                const doCopy = req.getSublistValue({ group, name: `custpage_${entityType}_${ccOrBcc}`, line }); // Yea, it is T/F for some reason
                // log.debug('getCCLines', `Sublist ${group} line ${line} do copy: ${doCopy}.`);
                if (doCopy == 'T')
                    emails.push(emailAddress);
            }
        });
        log.debug('getCCLines', `Addresses to ${ccOrBcc}: ${emails.length};`);
        return emails;
    }
    function getRecipientFromResult(result, searchField) {
        let recipient = '';
        if (searchField) { // We support parent.field joining
            let join = '';
            const columnName = ~searchField.indexOf('.') ? searchField.substring(searchField.indexOf('.') + 1) : searchField;
            if (~searchField.indexOf('.'))
                join = searchField.substring(0, searchField.indexOf('.'));
            result.columns.forEach((column) => {
                if (column.name == columnName && (!join || join == column.join))
                    recipient = result.getValue(column);
            });
        }
        else {
            recipient = result.id;
        }
        return recipient;
    }
    function mergeAndSendEmail(cc, bcc, relatedRecords, attachments, entityType, recipient, inputs) {
        const author = Number(inputs.custpage_author);
        const recipients = [recipient];
        let subject = inputs.custpage_subject;
        let body = inputs.custpage_body;
        if (runtime.getCurrentScript().getRemainingUsage() < 20)
            return false;
        if (inputs.custpage_template) {
            log.debug('Merging', `Merging ${inputs.custpage_search_type} ${recipient} with template ${inputs.custpage_template}; points remaining: ${runtime.getCurrentScript().getRemainingUsage()}.`);
            const renderer = render.mergeEmail({ entity: { type: inputs.custpage_search_type, id: Number(recipient) }, templateId: Number(inputs.custpage_template) }); // Costs no points?
            log.debug('Merge Complete', `Merged entity ${recipient} with template ${inputs.custpage_template}; points remaining: ${runtime.getCurrentScript().getRemainingUsage()}.`);
            body = renderer.body;
            subject = renderer.subject;
        }
        if (body && subject) {
            log.debug('Sending Email', `Author: ${author}; Recipient: ${recipient}; Subject: ${subject}; points remaining: ${runtime.getCurrentScript().getRemainingUsage()}.`);
            try {
                email.send({ author, recipients, subject, body, cc, bcc, relatedRecords, attachments }); // 20 points
                log.debug('Email Sent', `Sent email to entity ${recipient}; points remaining: ${runtime.getCurrentScript().getRemainingUsage()}.`);
            }
            catch (e) {
                log.error('mergeAndSendEmail', `Failed to send email to entity ${recipient}: ${e.message}`);
                return false;
            }
            return true;
        }
        else {
            log.debug('No Content', `Skipping email for recipient ${recipient}, no content was found.`);
            return false;
        }
    }
    function queueMapReduceScript(inputs, cc, bcc, request) {
        const author = Number(inputs.custpage_author);
        const subject = inputs.custpage_subject;
        const body = inputs.custpage_body;
        const template = inputs.custpage_template;
        const transaction = inputs.custpage_transaction;
        const printMode = inputs.custpage_print_mode;
        const campaignId = inputs.custpage_subscription;
        const savedSearch = inputs.custpage_saved_search;
        const searchType = inputs.custpage_search_type;
        const populateList = inputs.custpage_populate_list;
        const searchField = inputs.custpage_search_field;
        const data = { recipients: [], author, subject, body, cc, bcc, template, transaction, printMode, campaignId, savedSearch, searchType, populateList, searchField };
        ['contact', 'customer', 'employee', 'partner'].forEach((entityType) => {
            for (let line = 0; line < request.getLineCount({ group: `custpage_${entityType}s` }); line++) {
                const recipient = request.getSublistValue({ group: `custpage_${entityType}s`, name: `custpage_${entityType}_${entityType}`, line });
                const toLine = request.getSublistValue({ group: `custpage_${entityType}s`, name: `custpage_${entityType}_to`, line });
                if (toLine) {
                    if (data.recipients.length == 50000) { // We also do this in the map/reduce
                        const rec = record.create({ type: 'customrecord_hitc_mass_email_task' });
                        rec.setValue('custrecord_hitc_mass_email_task_data', JSON.stringify(data));
                        const recId = String(rec.save());
                        log.debug('queueMapReduceScript', `Email Task Record Created: ${recId} with recipients ${data.recipients.length}.`);
                        data.recipients = [];
                    }
                    data.recipients.push({ type: entityType, id: recipient });
                }
            }
        });
        const rec = record.create({ type: 'customrecord_hitc_mass_email_task' });
        rec.setValue('custrecord_hitc_mass_email_task_data', JSON.stringify(data));
        const recId = String(rec.save());
        log.debug('queueMapReduceScript', `Email Task Record Created: ${recId} with recipients ${data.recipients.length}.`);
        try {
            const scriptInstance = task.create({ taskType: task.TaskType.MAP_REDUCE, scriptId: 'customscript_hitc_mass_emailer_mr' }).submit();
            log.debug('queueMapReduceScript', `Map/Reduce script queued: ${scriptInstance}.`);
        }
        catch (e) { // Probably already running
            log.error('queueMapReduceScript', `Failed to trigger map/reduce script: ${e.message}`);
        }
        return recId;
    }
});
