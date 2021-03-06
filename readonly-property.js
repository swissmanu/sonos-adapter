'use strict';

const Property = require("./property");

class ReadonlyProperty extends Property {
    constructor(device, name, description, value) {
        description.readOnly = true;
        super(device, name, description, value);
    }

    setValue(value) {
        return Promise.reject("Read only property");
    }
}

module.exports = ReadonlyProperty;
