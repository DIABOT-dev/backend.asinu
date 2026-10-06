'use strict';

// Preserve the rest of the sentence, including units, medicine names and URLs.
function capitalizeFirstLetter(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\p{L}/u, (letter) => letter.toUpperCase())
    : value;
}

function formatPersonName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\p{L}[\p{L}\p{M}]*/gu, (word) => {
      // Normalize all-lowercase/all-uppercase names, preserving mixed-case
      // names such as McDonald rather than flattening their spelling.
      const normalized =
        word === word.toUpperCase() || word === word.toLowerCase() ? word.toLowerCase() : word;
      return capitalizeFirstLetter(normalized);
    });
}

module.exports = { capitalizeFirstLetter, formatPersonName };
