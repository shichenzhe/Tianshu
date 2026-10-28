import { Injectable } from '@nestjs/common';
import { Option } from './entity/option.entity';

@Injectable()
export class OptionService {
  private readonly options: Option[] = [];

  create(option: Option) {
    this.options.push(option);
  }

  findAll(): Option[] {
    return this.options;
  }
}
