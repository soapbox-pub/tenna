import noHtmlSinks from './no-html-sinks.js';
import noInlineScript from './no-inline-script.js';
import noPlaceholderComments from './no-placeholder-comments.js';
import requireWebmanifest from './require-webmanifest.js';

export default {
  rules: {
    'no-html-sinks': noHtmlSinks,
    'no-inline-script': noInlineScript,
    'no-placeholder-comments': noPlaceholderComments,
    'require-webmanifest': requireWebmanifest,
  },
};
