import util from 'util';

function getStringWidth(value) {
  return Array.from(String(value)).length;
}

function stripVTControlCharacters(value) {
  return String(value).replace(/\u001B\[[0-9;]*m/g, '');
}

function identicalSequenceRange(first, second) {
  const max = Math.min(first.length, second.length);
  let index = 0;
  while (index < max && first[index] === second[index]) {
    index += 1;
  }
  return [0, index];
}

const inspect = util.inspect;

export {
  getStringWidth,
  identicalSequenceRange,
  inspect,
  stripVTControlCharacters,
};

export default {
  getStringWidth,
  identicalSequenceRange,
  inspect,
  stripVTControlCharacters,
};
